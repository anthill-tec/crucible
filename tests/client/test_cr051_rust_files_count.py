"""CR-CRU-051 C2 RED -- propagate the run-envelope `files` (distinct test-FILE)
count to `rust-crucible.py`. Mode 1 (new tests), preceded by the ASSESSMENT the
C2 dispatch demanded: §S3 of docs/changes/CR-CRU-051-files-count-fleet-parity.md
claims "rust has TWO parse sites: rust-crucible.py:762 and :1306". Both line
numbers are stale (CR-054 shrank the file). Located by symbol instead, rust
today has THREE places that turn a nextest run into a test count, not two --
and only two of them are actually client-parsed:

  SITE 1 -- `_regression_ingest_run` (verb `regression-ingest`), an inline
  `ET.parse(junit_path)` at ~line 655. CLIENT-PARSED: the client walks the
  <testsuite>/<testcase> tree itself, builds `summary`/`tree`, and POSTs to
  /api/v2/runs/parsed. §S3's claim is directionally right for this site.

  SITE 2 -- `_workspace_regression_run` (verb `workspace-regression`, the
  pre-merge-gate path §S3 names), an inline `ET.parse(junit_path)` at ~line
  1207. CLIENT-PARSED, structurally identical to site 1 (its own copy of the
  same parse loop -- rust has no shared `_parse_junit` helper the way
  python/mvn/arduino do).

  SITE 3 -- NOT in §S3 at all, and it changes the picture: `_ingest_junit_axi`
  (~line 771), used by BOTH the `auto-ingest` verb (`cmd_auto_ingest`) and the
  `test` verb (`cmd_test`). This POSTs `{"codec": "junit", "dataPath":
  junit_path, ...}` to /api/v2/runs -- the SERVER parses the XML
  (server-side codec=junit). rust-crucible.py never sees a single <testcase>
  for this path. SERVER-PARSED: there is no client-side distinct-source data
  to count here, so emitting a `files` key would mean INVENTING a number.
  The CR's own 2026-08-02 gap-analysis note already flags this site's
  existence and its correct exclusion; this file is what pins it.

A second correction, orthogonal to the site count: §S2 says "surface it in
the envelope and the plain count lines" as if every site has both. Measured
against the CURRENT source, sites 1 and 2 (the two CLIENT-PARSED sites) print
a bare `print(f"regression: ok=... passed=... failed=... pending=...
total=...")` / `print(f"workspace regression: ok=...")` line -- NEITHER goes
through `_emit_axi`/`_emit_ingest_axi`, so neither has a TOON `run:` envelope
to put `files` into. The ONLY site with a `run:` envelope is site 3
(`_emit_ingest_axi`, shared by `auto-ingest`/`test`), and that is precisely
the SERVER-PARSED site that cannot honestly carry `files`. So for rust,
"surface it in envelope AND human line" resolves to: human line only, on
sites 1 and 2; no `files` key anywhere on site 3's envelope.

Granularity, resolved empirically (NOT trusted from the CR doc, which never
measured rust at all): a throwaway crate was built and run with the actual
`cargo-nextest 0.9.130` installed on this machine (2 test files, 3 #[test]
fns). The real JUnit output stamps `classname` (e.g.
"probe_crate::probe_test") on every <testcase> and NEVER a `file` attribute.
`classname` is the BINARY id (crate::test-file-stem) -- for `tests/*.rs`
integration tests each source file compiles to its own binary, so `classname`
coincides with per-FILE precision there; for `src/`-embedded unit tests,
multiple modules across several source files can share one lib test binary
and therefore one classname, coarsening the count. The resolved rung is
therefore per-FILE for the common integration-test layout, degrading to
per-BINARY (coarser than per-file) when unit tests share a binary -- worth
stating honestly rather than claiming blanket per-file precision. The
fallback chain itself is unchanged from bun's reference (`file` first, since
some other harness feeding this same parse loop might supply it; `classname`
second; suite name last) -- nextest simply never exercises rung 1 today.

RED phase: neither `_regression_ingest_run` nor `_workspace_regression_run`
computes or prints any `files=` value today (confirmed by reading the
source) -- the printed lines carry only `ok=/passed=/failed=/pending=/
total=`. Every site-1/site-2 test below therefore fails now for the right
reason (a plain `assertIn("files=", ...)` / regex-search miss, not an
exception). The site-3 pins are BORN GREEN: `_emit_ingest_axi`'s `run` dict
is hardcoded to exactly `{passed, failed, pending, total}`
(clients/rust-crucible.py:321-322) and the server-parsed POST body has no
client-computed `summary` at all -- there is no `files` key to accidentally
carry today, so the pin is a forward-looking regression guard, not new
capability. Stated explicitly per the sub-agent procedure's requirement that
a passing-on-first-run test be justified, not silently included.

Module-loading + HTTP-mocking convention copied verbatim from the sibling
`test_rust_crucible_axi.py` harness: load the client by file path via
`importlib`, mock the module's `_post`/`_get` HTTP transport seam so the live
Crucible server on :3849 is NEVER touched. `subprocess.run` is mocked with a
side_effect that writes a real nextest-shaped JUnit fixture at the exact path
the client already looks for (mirroring
`RustCrucibleToolchainTest.test_test_verb_runs_cargo_nextest_and_ingests_with_run_summary`),
while `git`/`df` invocations (gate-lock resolution, disk-guard measurement)
are passed through to the REAL `subprocess.run` captured before any patching
-- both are read-only against a tmpdir that is not a git repo, so they
degrade harmlessly (no lock, disk check answers a real number) without
faking process-table state. `--min-free-g 1` and `--keep-target` keep the
`workspace-regression` disk-guard/reclaim scaffolding (orthogonal to this
CR) out of the way without mocking it into a false shape.

Invocation:
    python3 -m pytest tests/client/test_cr051_rust_files_count.py -q
Fallback:
    python3 tests/client/test_cr051_rust_files_count.py
"""

import ast
import contextlib
import importlib.util
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
RUST_SCRIPT = CLIENTS_DIR / "rust-crucible.py"
TOON_SCRIPT = CLIENTS_DIR / "toon.py"

# Captured BEFORE any mock.patch touches `subprocess.run` -- `subprocess` is a
# process-wide singleton module, so patching `self.module.subprocess.run`
# patches THIS test file's `subprocess.run` too (same module object). This
# reference stays the genuine implementation for git/df passthrough.
_REAL_SUBPROCESS_RUN = subprocess.run


def _load_module_by_path(path, cache_key):
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    full_argv = ["rust-crucible.py"] + argv
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", full_argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                if e.code is None:
                    code = 0
                elif isinstance(e.code, int):
                    code = e.code
                else:
                    code = 1
    return code, stdout.getvalue(), stderr.getvalue()


def _post_call_for_path(post_mock, path):
    for call in post_mock.call_args_list:
        args, kwargs = call
        call_path = args[0] if args else kwargs.get("path")
        if call_path == path:
            return call
    return None


def _open_plans_response(plans):
    return {"ok": True, "plans": plans}


def _active_cycle_plans(active_id=808):
    """Copied verbatim (shape) from test_rust_crucible_axi.py's
    `_BaseRustAxiTest._active_cycle_plans` -- an open plan with an ACTIVE
    cycle, so `_open_gate_identity`'s auto-attach has somewhere to land
    instead of hard-erroring before `_regression_ingest_run` is even
    reached."""
    return _open_plans_response([
        {"planId": "plan-active", "cr": "CR-CRU-051", "status": "open",
         "cycles": [{"id": active_id, "status": "active"},
                    {"id": active_id - 1, "status": "done"}]},
    ])


def _write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


# ── real nextest 0.9.130 JUnit shapes (measured empirically, see module
# docstring) -- `classname` present, `file` NEVER present. ──────────────────

# Two distinct test binaries (classnames) across 3 testcases, mirroring the
# probe measurement (`probe_crate::second_probe_test` / `probe_crate::probe_test`).
NEXTEST_TWO_BINARIES = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<testsuites name="nextest-run" tests="3" failures="0" errors="0">'
    '<testsuite name="probe_crate::second_probe_test" tests="1" disabled="0" errors="0" failures="0">'
    '<testcase name="second_file_passes" classname="probe_crate::second_probe_test" time="0.003"/>'
    '</testsuite>'
    '<testsuite name="probe_crate::probe_test" tests="2" disabled="0" errors="0" failures="0">'
    '<testcase name="it_passes" classname="probe_crate::probe_test" time="0.003"/>'
    '<testcase name="it_also_passes" classname="probe_crate::probe_test" time="0.003"/>'
    '</testsuite>'
    '</testsuites>'
)

# Neither `file` NOR `classname` anywhere -- the deepest fallback rung (suite
# name only). Two distinct suites, one testcase each.
NEXTEST_BARE = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<testsuites name="nextest-run" tests="2" failures="0" errors="0">'
    '<testsuite name="probe_crate::bare_one" tests="1" disabled="0" errors="0" failures="0">'
    '<testcase name="test_x" time="0.001"/>'
    '</testsuite>'
    '<testsuite name="probe_crate::bare_two" tests="1" disabled="0" errors="0" failures="0">'
    '<testcase name="test_y" time="0.001"/>'
    '</testsuite>'
    '</testsuites>'
)


def _function_source_segment(path, name):
    """AST-extract the exact source text of a top-level `def <name>` --
    copied verbatim from test_cr054_verb_surface_lift.py /
    test_cr051_files_count_parity.py's `_function_source_segment`."""
    text = path.read_text()
    tree = ast.parse(text, filename=str(path))
    for node in tree.body:
        if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == name):
            return ast.get_source_segment(text, node)
    return None


def _passthrough_or_noop_subprocess_run(cmd, *args, **kwargs):
    """Default fallback for cmd/tool paths this file doesn't care about --
    git/df get the REAL implementation (read-only, harmless against a tmpdir
    that isn't a git repo); anything else is a silent no-op success."""
    if cmd and cmd[0] in ("git", "df"):
        return _REAL_SUBPROCESS_RUN(cmd, *args, **kwargs)
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


# ── SITE 1: `_regression_ingest_run` / verb `regression-ingest` ────────────
# CLIENT-PARSED: inline ET.parse, builds summary+tree itself, POSTs to
# /api/v2/runs/parsed. Prints a PLAIN line (`regression: ok=...`) -- no TOON
# envelope at all for this verb.


class RustRegressionIngestFilesCountTest(unittest.TestCase):
    PROJECT_KEY = "cr051-c2-rust-regr-key"

    def setUp(self):
        self.module = _load_module_by_path(RUST_SCRIPT, "cr051_c2_rust_regr_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="cr051-c2-rust-regr-")
        _write(os.path.join(self.tmpdir, ".env"),
               f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_cycle_env = os.environ.get("WORKFLOW_CYCLE_ID")
        os.environ.pop("WORKFLOW_CYCLE_ID", None)

    def tearDown(self):
        if self._saved_cycle_env is None:
            os.environ.pop("WORKFLOW_CYCLE_ID", None)
        else:
            os.environ["WORKFLOW_CYCLE_ID"] = self._saved_cycle_env
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _junit_path(self):
        return os.path.join(self.tmpdir, "target", "nextest", "ci", "junit.xml")

    def _fake_subprocess_run(self, xml_content):
        junit_path = self._junit_path()

        def fake(cmd, *args, **kwargs):
            if len(cmd) >= 2 and cmd[0] == "cargo" and cmd[1] == "llvm-cov":
                _write(junit_path, xml_content)
                return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
            return _passthrough_or_noop_subprocess_run(cmd, *args, **kwargs)
        return fake

    def test_regression_ingest_prints_files_count_of_distinct_classnames(self):
        """§S1/§S2 AC: the human-readable `regression: ok=...` line must carry
        `files=2` -- 2 distinct nextest classnames (test binaries) across 3
        testcases. nextest never stamps `file` (measured empirically against
        the real cargo-nextest 0.9.130 installed on this machine), so the
        count here is genuinely classname-derived. A no-op GREEN that leaves
        the line unchanged fails this at the substring check, not a crash."""
        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=self._fake_subprocess_run(NEXTEST_TWO_BINARIES)), \
             mock.patch.object(self.module, "_post", return_value={"ok": True}, create=True), \
             mock.patch.object(self.module, "_get", return_value=_active_cycle_plans(),
                                create=True):
            code, out, err = _run_main(self.module, [
                "regression-ingest", "--project-dir", self.tmpdir,
                "--crates", "some-crate", "--agent", "CR-CRU-051-C2-rust-regr-check",
            ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertIn("passed=3", out)
        self.assertIn("total=3", out)
        self.assertIn(
            "files=2", out,
            f"the 'regression: ok=...' line must carry files=2 (2 distinct "
            f"classnames: probe_crate::second_probe_test, "
            f"probe_crate::probe_test); got stdout={out!r}")

    def test_regression_ingest_files_count_never_zero_via_suite_name_fallback(self):
        """AC (verbatim): "A report whose testcases carry no `file` attribute
        still yields a NON-ZERO `files` count via the `classname` ->
        suite-name fallback." Here no testcase carries `classname` OR `file`
        -- only the two distinct suite names are available."""
        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=self._fake_subprocess_run(NEXTEST_BARE)), \
             mock.patch.object(self.module, "_post", return_value={"ok": True}, create=True), \
             mock.patch.object(self.module, "_get", return_value=_active_cycle_plans(),
                                create=True):
            code, out, err = _run_main(self.module, [
                "regression-ingest", "--project-dir", self.tmpdir,
                "--crates", "some-crate", "--agent", "CR-CRU-051-C2-rust-regr-bare",
            ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertIn("total=2", out)
        match = re.search(r"files=(\d+)", out)
        self.assertIsNotNone(
            match, f"'files=' must appear in the printed line at all; got stdout={out!r}")
        files = int(match.group(1))
        self.assertGreater(
            files, 0,
            "files must NEVER degrade to 0 -- a constant zero would make a "
            "shrinking suite look identical to a healthy one")
        self.assertEqual(
            files, 2,
            f"with no file/classname anywhere, files must fall back to the "
            f"2 distinct SUITE names; got files={files!r}")

    def test_granularity_is_documented_in_a_comment_beside_regression_ingest(self):
        """AC: "The resolved granularity per client (file vs class) is
        recorded in a comment beside each implementation." rust's classname is
        the test-binary id -- per-FILE for the common tests/*.rs integration
        layout, coarser when unit tests share a lib binary -- that must be
        readable in the source next to the parse loop it describes."""
        body = _function_source_segment(RUST_SCRIPT, "_regression_ingest_run")
        self.assertIsNotNone(body, "_regression_ingest_run must exist as a top-level def")
        self.assertIn(
            "granularity", body.lower(),
            "_regression_ingest_run's comment must record its resolved "
            "files-count granularity -- not present yet")

    def test_ingest_payload_never_carries_files_key(self):
        """Non-goal / AC (verbatim): "files rides the printed envelope only,
        never the ingest payload." `_regression_ingest_run`'s `summary` dict
        IS `/api/v2/runs/parsed`'s `summary` field verbatim -- a naive GREEN
        that stuffs `files` INTO summary (rather than threading it as a
        sibling local variable used only for the print line) would leak it
        onto the wire. Born GREEN today (summary has no `files` key at all
        yet) -- a forward-looking regression guard against this CR's own
        edit, not new capability."""
        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=self._fake_subprocess_run(NEXTEST_TWO_BINARIES)), \
             mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=_active_cycle_plans(),
                                create=True):
            code, out, _err = _run_main(self.module, [
                "regression-ingest", "--project-dir", self.tmpdir,
                "--crates", "some-crate", "--agent", "CR-CRU-051-C2-rust-regr-nofiles",
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        payload = ingest_call[0][1]
        self.assertNotIn("files", payload,
                         "the ingest payload's top level must never carry a files key")
        self.assertNotIn(
            "files", payload.get("summary", {}),
            "the ingest payload's summary must never carry a files key -- "
            "it rides the printed line only (CR-CRU-047 §S2's contract)")


# ── SITE 2: `_workspace_regression_run` / verb `workspace-regression` ──────
# CLIENT-PARSED, the pre-merge-gate path §S3 names. Structurally its own copy
# of the same inline ET.parse loop (no shared helper) -- prints a PLAIN line
# (`workspace regression: ok=...`), no TOON envelope either.


class RustWorkspaceRegressionFilesCountTest(unittest.TestCase):
    PROJECT_KEY = "cr051-c2-rust-ws-key"

    def setUp(self):
        self.module = _load_module_by_path(RUST_SCRIPT, "cr051_c2_rust_ws_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="cr051-c2-rust-ws-")
        _write(os.path.join(self.tmpdir, ".env"),
               f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _junit_path(self, profile="ci"):
        return os.path.join(self.tmpdir, "target", "nextest", profile, "junit.xml")

    def _fake_subprocess_run(self, xml_content):
        junit_path = self._junit_path()

        def fake(cmd, *args, **kwargs):
            if len(cmd) >= 2 and cmd[0] == "cargo" and cmd[1] == "llvm-cov":
                _write(junit_path, xml_content)
                return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
            return _passthrough_or_noop_subprocess_run(cmd, *args, **kwargs)
        return fake

    def _run_workspace_regression(self, xml_content):
        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=self._fake_subprocess_run(xml_content)), \
             mock.patch.object(self.module, "_post", return_value={"ok": True}, create=True):
            return _run_main(self.module, [
                "workspace-regression", "--project-dir", self.tmpdir,
                "--agent", "CR-CRU-051-C2-rust-ws-check",
                "--min-free-g", "1", "--keep-target",
            ])

    def test_workspace_regression_prints_files_count_of_distinct_classnames(self):
        """Same AC as site 1, mirrored at the pre-merge-gate path -- this is
        the trap CR-CRU-050 flagged: fixing only site 1 looks complete and
        leaves the merge gate's own count blind."""
        code, out, err = self._run_workspace_regression(NEXTEST_TWO_BINARIES)
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertIn("passed=3", out)
        self.assertIn("total=3", out)
        self.assertIn(
            "files=2", out,
            f"the 'workspace regression: ok=...' line must carry files=2; "
            f"got stdout={out!r}")

    def test_workspace_regression_files_count_never_zero_via_suite_name_fallback(self):
        code, out, err = self._run_workspace_regression(NEXTEST_BARE)
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertIn("total=2", out)
        match = re.search(r"files=(\d+)", out)
        self.assertIsNotNone(
            match, f"'files=' must appear in the printed line at all; got stdout={out!r}")
        files = int(match.group(1))
        self.assertGreater(files, 0, "files must never degrade to 0")
        self.assertEqual(
            files, 2,
            f"with no file/classname anywhere, files must fall back to the "
            f"2 distinct SUITE names; got files={files!r}")

    def test_granularity_is_documented_in_a_comment_beside_workspace_regression(self):
        body = _function_source_segment(RUST_SCRIPT, "_workspace_regression_run")
        self.assertIsNotNone(body, "_workspace_regression_run must exist as a top-level def")
        self.assertIn(
            "granularity", body.lower(),
            "_workspace_regression_run's comment must record its resolved "
            "files-count granularity -- not present yet")

    def test_ingest_payload_never_carries_files_key(self):
        """Born GREEN today (no `files` key exists here yet) -- guards
        against this CR leaking `files` into the /api/v2/runs/parsed
        `summary` at the pre-merge-gate site."""
        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=self._fake_subprocess_run(NEXTEST_TWO_BINARIES)), \
             mock.patch.object(self.module, "_post", return_value={"ok": True},
                                create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "workspace-regression", "--project-dir", self.tmpdir,
                "--agent", "CR-CRU-051-C2-rust-ws-nofiles",
                "--min-free-g", "1", "--keep-target",
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs/parsed")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        payload = ingest_call[0][1]
        self.assertNotIn("files", payload,
                         "the ingest payload's top level must never carry a files key")
        self.assertNotIn(
            "files", payload.get("summary", {}),
            "the ingest payload's summary must never carry a files key")


# ── SITE 3 (assessment finding, not in §S3): `_ingest_junit_axi` / verbs
# `auto-ingest` and `test` -- SERVER-PARSED (codec=junit; the SERVER walks
# `dataPath`). No client-side testcase data exists here to count. These pins
# guard the honest absence: emitting `files` on this path would be invented,
# not measured. Born GREEN -- `_emit_ingest_axi`'s `run` dict
# (clients/rust-crucible.py:321-322) is a hardcoded 4-key literal today; there
# is no `files` key to accidentally leak. ─────────────────────────────────


PASS_JUNIT_XML = (
    '<?xml version="1.0"?>'
    '<testsuites><testsuite name="fixture" tests="1" failures="0">'
    '<testcase name="test_passes" classname="fixture" time="0.001"/>'
    '</testsuite></testsuites>'
)


class RustServerParsedSitesNeverFabricateFilesTest(unittest.TestCase):
    PROJECT_KEY = "cr051-c2-rust-serverparse-key"

    def setUp(self):
        self.module = _load_module_by_path(RUST_SCRIPT, "cr051_c2_rust_serverparse_under_test")
        self.toon = _load_module_by_path(TOON_SCRIPT, "cr051_c2_toon_for_rust_serverparse")
        self.tmpdir = tempfile.mkdtemp(prefix="cr051-c2-rust-serverparse-")
        _write(os.path.join(self.tmpdir, ".env"),
               f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_cycle_env = os.environ.get("WORKFLOW_CYCLE_ID")
        os.environ.pop("WORKFLOW_CYCLE_ID", None)

    def tearDown(self):
        if self._saved_cycle_env is None:
            os.environ.pop("WORKFLOW_CYCLE_ID", None)
        else:
            os.environ["WORKFLOW_CYCLE_ID"] = self._saved_cycle_env
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_test_verb_run_envelope_never_carries_a_files_key(self):
        """PIN: the `test` verb's TOON `run:` envelope (built by
        `_emit_ingest_axi` from the SERVER's parsed response) must never
        carry `files` -- rust-crucible.py never sees the raw XML for this
        verb (codec=junit is a server-side parse), so there is no
        distinct-source count it could honestly report. This is the ONLY
        rust site with a `run:` envelope at all, and it is exactly the one
        that cannot carry the count -- the opposite of what §S2's "surface
        it in the envelope" instruction assumes is available here."""
        nextest_dir = os.path.join(self.tmpdir, "target", "nextest", "ci")
        os.makedirs(nextest_dir, exist_ok=True)
        _write(os.path.join(nextest_dir, "junit.xml"), PASS_JUNIT_XML)

        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=_passthrough_or_noop_subprocess_run), \
             mock.patch.object(self.module, "_post",
                               return_value={"ok": True,
                                              "run": {"passed": 1, "failed": 0,
                                                       "pending": 0, "total": 1}},
                               create=True):
            code, out, err = _run_main(self.module, [
                "test", "--project-dir", self.tmpdir, "--crate", "some-crate",
                "--agent", "CR-CRU-051-C2-rust-testverb-check",
            ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        decoded = self.toon.decode(out)
        axi = decoded["axi"]
        run = axi.get("run")
        self.assertIsInstance(run, dict)
        self.assertEqual(run.get("total"), 1)
        self.assertNotIn(
            "files", run,
            f"the test verb's run: envelope must NEVER carry a files key -- "
            f"parsing happens SERVER-side (codec=junit); the client has no "
            f"distinct-source data to count; got run={run!r}")

    def test_auto_ingest_verb_run_envelope_never_carries_a_files_key(self):
        """Same pin as above for `auto-ingest` -- a distinct CLI verb that
        shares the identical `_ingest_junit_axi` -> `_emit_ingest_axi` path."""
        nextest_dir = os.path.join(self.tmpdir, "target", "nextest", "ci")
        os.makedirs(nextest_dir, exist_ok=True)
        _write(os.path.join(nextest_dir, "junit.xml"), PASS_JUNIT_XML)

        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=_passthrough_or_noop_subprocess_run), \
             mock.patch.object(self.module, "_post",
                               return_value={"ok": True,
                                              "run": {"passed": 1, "failed": 0,
                                                       "pending": 0, "total": 1}},
                               create=True):
            code, out, err = _run_main(self.module, [
                "auto-ingest", "--project-dir", self.tmpdir, "--crate", "some-crate",
                "--agent", "CR-CRU-051-C2-rust-autoingest-check",
            ])
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        decoded = self.toon.decode(out)
        run = decoded["axi"].get("run")
        self.assertIsInstance(run, dict)
        self.assertEqual(run.get("total"), 1)
        self.assertNotIn(
            "files", run,
            f"the auto-ingest verb's run: envelope must NEVER carry a files "
            f"key -- same server-parsed path as the test verb; got run={run!r}")

    def test_test_verb_ingest_payload_never_carries_a_files_key(self):
        """The POST /api/v2/runs body for this verb has no client-computed
        `summary` at all (only projectKey/codec/dataPath/agentId/tier/
        context) -- confirming there is structurally nowhere for a fabricated
        `files` count to hide on the wire either."""
        nextest_dir = os.path.join(self.tmpdir, "target", "nextest", "ci")
        os.makedirs(nextest_dir, exist_ok=True)
        _write(os.path.join(nextest_dir, "junit.xml"), PASS_JUNIT_XML)

        with mock.patch.object(self.module.subprocess, "run",
                                side_effect=_passthrough_or_noop_subprocess_run), \
             mock.patch.object(self.module, "_post",
                               return_value={"ok": True,
                                              "run": {"passed": 1, "failed": 0,
                                                       "pending": 0, "total": 1}},
                               create=True) as post_mock:
            code, out, _err = _run_main(self.module, [
                "test", "--project-dir", self.tmpdir, "--crate", "some-crate",
                "--agent", "CR-CRU-051-C2-rust-testverb-nofiles",
            ])
        self.assertEqual(code, 0, f"stdout={out!r}")
        ingest_call = _post_call_for_path(post_mock, "/api/v2/runs")
        self.assertIsNotNone(ingest_call, "the run must actually be POSTed")
        payload = ingest_call[0][1]
        self.assertNotIn("files", payload,
                         "the server-parsed ingest payload must never carry a files key")
        self.assertEqual(
            payload.get("codec"), "junit",
            "confirms this really is the server-parsed path under test")


if __name__ == "__main__":
    unittest.main()
