"""CR-CRU-170 §S3/AC3 RED — the e2e verb (and every OTHER declared-tier verb)
runs only the features/args it is asked.

AC3's own words: "`e2e … -- <args>` passes exactly `<args>` to the declared
target and files exactly the results its report holds; without `--` the
target receives no extra argument. Asserted with a fixture target shaped
`a && b` that records its argv and writes a Playwright-shaped report."

THE MECHANISM (measured against the real bun 1.4.2 binary this project pins
— `engines.bun: ">=1.2"` — at /tmp/bun-probe, 2026, before writing the fake
below): `bun run <script> -- <args>` and `bun run <script> <args>` forward
IDENTICALLY. The extra argv is appended to the END of the script's own
command STRING, so for a `&&`-joined script it reaches only the LAST
sub-command, and any literal `--` token is never forwarded to it:

    $ cat package.json
    {"scripts": {"test:e2e": "echo noop && ./record.sh last"}}
    $ bun run test:e2e -- --grep "a title with spaces" tests/x.feature
    $ bun run test:e2e    --grep "a title with spaces" tests/x.feature
    # both record: "last --grep a title with spaces tests/x.feature"
    # ("noop" records nothing — it never sees the passthrough at all)

That is why the fake `bun` below is a faithful line-for-line port of this
measurement, not an invention: `bun run <script> [-- ]<args>` executes the
declared script's own command STRING with `<args>` (`shlex.quote`d,
leading `--` stripped) appended to the end of it, via the shell — exactly
what the real binary does.

RED today (confirmed by direct invocation, no fixture involved):

    $ python3 clients/bun-crucible.py e2e --agent X --project-dir /tmp \
          --package-dir /tmp -- tests/e2e/features/x.feature
    usage: bun-crucible [-h] {register,unregister,...} ...
    bun-crucible: error: unrecognized arguments: -- tests/e2e/features/x.feature
    $ echo $?
    2

`_add_declared_tier_args` (`clients/bun-crucible.py`) defines no positional
to catch what follows a bare `--`, and `_bun_run_script_cmd` builds
`[bun, "run", script]` with no provision for appending anything the caller
typed — so argparse's own top-level parser rejects the whole invocation
before `cmd_regression` (let alone `_bun_run_script_cmd`) ever runs. Every
RED test below therefore fails at `subprocess.run(...).returncode == 2`
("unrecognized arguments"), never on an import/fixture error: the fixture
project, the fake `bun`, and the `RecordingBoard` are all exercised by the
PIN test (`NoDashDashLeavesTheDeclaredTargetUnchangedTest`, item 3) and pass
there today, proving the fixture itself is sound.

Driven as a REAL subprocess of `clients/bun-crucible.py` against a real
`RecordingBoard` HTTP server (`tests/client/live_run_harness.py`) — never
in-process module loading with a mocked `_post`. `live_run_harness.write_fake_bun`
is NOT reused here: it answers only `bun test`'s own flag contract and never
executes `bun run <script>` at all (confirmed by reading `FAKE_BUN` in that
module), so it cannot run a declared target's package script — exactly the
"only if it actually runs package scripts" condition that sends this file to
build its own faithful `bun run` fake instead, following the convention the
DECLARED-TARGET harnesses already use for that
(`test_declared_target_report_mechanism.py`'s `_FAKE_BUN_TAIL`,
`test_bun_crucible_agent_report_isolation.py`'s `_FAKE_BUN_TEMPLATE`): a fake
that executes the fixture's OWN `package.json` script body via the shell, so
a run dispatched through a declared script is not invisible to the fixture.

Invocation:
    python3 -m unittest tests.client.test_declared_tier_passthrough_after_dashdash -v
"""

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
)

BUN_CLIENT = CLIENTS / "bun-crucible.py"
TOON = load_toon()

AGENT = "cr170-dashdash-passthrough-probe"
PROJECT_KEY = "cr170-dashdash-passthrough-key"
PROJECT_NAME = "cr170-dashdash-passthrough-project"

RAW_INGEST_PATH = "/api/v2/runs"
ARGV_LOG_VAR = "CR170_ARGV_LOG"

# The project's own `crucible.reportPath`/`rawReport` vocabulary, reused
# verbatim (same `env:<VAR>` mechanism, same `{codec, file, path}` shape this
# repo's real `package.json` declares for `test:e2e`) — only the variable
# NAMES differ per fixture target so two declared targets in the same
# process never collide on the same env var.
E2E_JUNIT_VAR = "PLAYWRIGHT_JUNIT_OUTPUT_NAME"
E2E_JSON_VAR = "PLAYWRIGHT_JSON_OUTPUT_NAME"
MODULE_JUNIT_VAR = "MODULE_JUNIT_OUTPUT_NAME"
MODULE_JSON_VAR = "MODULE_JSON_OUTPUT_NAME"

# What the LAST command's fake runner writes when it was asked for nothing in
# particular (no `--`) — standing in for "the whole suite ran".
WHOLE_SUITE_CASES = ["suite-case-1", "suite-case-2", "suite-case-3"]

# ── fixture scripts ─────────────────────────────────────────────────────────
# Shared head: every fake tool records what it was asked to run (empty argv
# counts — a tool invoked with none is recorded as `"argv": []`, proving a
# receipt rather than an absence of one) BEFORE doing anything else, so a
# refusal is as visible as a run.
_RECORD_HEAD = '''#!__PY__
import json
import os
import sys

argv = sys.argv[1:]
_log = os.environ.get("''' + ARGV_LOG_VAR + '''")
if _log:
    with open(_log, "a") as _handle:
        _handle.write(json.dumps({"tool": "__TOOL__", "argv": argv}) + "\\n")
'''

_NOOP_TAIL = "sys.exit(0)\n"

# The LAST command: writes a Playwright-JSON-shaped report holding exactly
# one case per non-flag argument it was handed (its own static leading
# "test" token, present whether or not `--` was used, is never counted as a
# case); with nothing but "test", it stands in for "the whole suite ran".
_RECORDER_TAIL = '''
_features = [a for a in argv[1:] if not a.startswith("-")]
if not _features:
    _features = ''' + repr(WHOLE_SUITE_CASES) + '''
_specs = [{"title": f, "file": f,
           "tests": [{"results": [{"status": "passed"}]}]}
          for f in _features]
_report = {"suites": [{"specs": _specs}], "stats": {"expected": len(_features)}}
_outfile = os.environ.get("__REPORT_VAR__")
if _outfile:
    _directory = os.path.dirname(_outfile)
    if _directory:
        os.makedirs(_directory, exist_ok=True)
    with open(_outfile, "w") as _handle:
        json.dump(_report, _handle)
sys.exit(0)
'''

# A faithful `bun run <script> [-- ]<args>`, line-for-line matching the real
# binary's measured behaviour (module docstring above): the declared
# script's own command STRING, with `<args>` (quoted, any leading `--`
# stripped) appended to its END and executed by the shell — so the args
# reach only the LAST `&&`-joined command, exactly as real bun's own
# argument-forwarding does.
_FAKE_BUN = '''#!__PY__
import json
import os
import shlex
import subprocess
import sys

argv = sys.argv[1:]
if argv[:1] != ["run"] or len(argv) < 2:
    sys.stderr.write("fake-bun: only `bun run <script>` is faithful here\\n")
    sys.exit(1)
script = argv[1]
try:
    with open(os.path.join(os.getcwd(), "package.json")) as _handle:
        scripts = (json.load(_handle) or {}).get("scripts") or {}
except OSError:
    scripts = {}
body = scripts.get(script)
if body is None:
    sys.stderr.write("error: Script not found \\"%s\\"\\n" % script)
    sys.exit(1)
passthrough = argv[2:]
if passthrough[:1] == ["--"]:
    passthrough = passthrough[1:]
command = " ".join([body] + [shlex.quote(a) for a in passthrough])
sys.exit(subprocess.run(command, shell=True, cwd=os.getcwd()).returncode)
'''


def _write_executable(path, text):
    path.write_text(text)
    os.chmod(path, 0o755)
    return str(path)


def _write_fake_bun(root):
    return _write_executable(root / "fake-bun",
                             _FAKE_BUN.replace("__PY__", sys.executable))


def _write_tool(root, name, tool_tag, tail):
    text = (_RECORD_HEAD.replace("__PY__", sys.executable)
            .replace("__TOOL__", tool_tag) + tail)
    return _write_executable(root / name, text)


def _write_recorder(root, name, tool_tag, report_var):
    return _write_tool(root, name, tool_tag,
                       _RECORDER_TAIL.replace("__REPORT_VAR__", report_var))


def _declare(root, scripts, report_path, raw_report):
    manifest = {
        "name": "cr170-dashdash-fixture",
        "scripts": scripts,
        "crucible": {"reportPath": report_path, "rawReport": raw_report},
    }
    (root / "package.json").write_text(json.dumps(manifest, indent=2))


# ── the harness ──────────────────────────────────────────────────────────

class _DashDashCase(unittest.TestCase):
    """A throwaway bun project, its own `RecordingBoard`, a faithful fake
    `bun`, and the `a` half of every fixture's `a && b` declared script (the
    `b` half — the recorder — is built per test class, since its report
    mechanism/variable differs)."""

    def setUp(self):
        self.project = Path(new_scratch("cr170-dashdash-"))
        self.board = RecordingBoard()
        install_project(str(self.project), self.board.url, PROJECT_KEY,
                        PROJECT_NAME)
        self.argv_log = self.project / "argv.jsonl"
        self.fake_bun = _write_fake_bun(self.project)
        self.fake_noop = _write_tool(self.project, "fake-noop", "noop",
                                     _NOOP_TAIL)

    def tearDown(self):
        self.board.close()
        shutil.rmtree(str(self.project), ignore_errors=True)

    # ── fixture construction ────────────────────────────────────────────

    def write_recorder(self, name, report_var):
        return _write_recorder(self.project, name, "last", report_var)

    def declare_e2e(self):
        """`test:e2e`, shaped `a && b`: the SAME `crucible.reportPath` /
        `crucible.rawReport` declarations this repo's own `package.json`
        carries for `test:e2e` (`env:PLAYWRIGHT_JUNIT_OUTPUT_NAME` /
        `{codec: "playwright", file: "playwright.json",
        path: "env:PLAYWRIGHT_JSON_OUTPUT_NAME"}`), only the two commands
        are this fixture's own fake tools."""
        recorder = self.write_recorder("fake-e2e-last", E2E_JSON_VAR)
        _declare(self.project,
                scripts={"test:e2e": f"{self.fake_noop} && {recorder} test"},
                report_path={"test:e2e": f"env:{E2E_JUNIT_VAR}"},
                raw_report={"test:e2e": {
                    "codec": "playwright", "file": "playwright.json",
                    "path": f"env:{E2E_JSON_VAR}"}})

    # ── driving ──────────────────────────────────────────────────────────

    def env(self):
        return scrubbed_env(None, **{ARGV_LOG_VAR: str(self.argv_log)})

    def run_client(self, argv):
        cmd = [sys.executable, str(BUN_CLIENT)] + argv
        return subprocess.run(cmd, cwd=str(self.project), env=self.env(),
                              capture_output=True, text=True, timeout=60)

    def drive(self, verb, extra=()):
        return self.run_client(
            [verb, "--agent", AGENT, "--project-dir", str(self.project),
             "--package-dir", str(self.project), "--bun", self.fake_bun,
             *extra])

    # ── measurement ──────────────────────────────────────────────────────

    def invocations(self, tool):
        """What the operating system actually ran, for one named fake
        tool, in the order it ran."""
        if not self.argv_log.exists():
            return []
        records = [json.loads(line) for line in
                  self.argv_log.read_text().splitlines() if line.strip()]
        return [r["argv"] for r in records if r["tool"] == tool]

    def raw_ingests(self):
        return [(path, body) for path, body in self.board.posts()
               if path == RAW_INGEST_PATH]

    def axi(self, stdout):
        decoded = TOON.decode(stdout)
        self.assertIn("axi", decoded, f"stdout is not one TOON envelope: {stdout!r}")
        return decoded["axi"]


# ── item 1 — a single feature path after `--` ──────────────────────────────

class FeatureArgumentAfterDashDashReachesOnlyTheLastCommandTest(_DashDashCase):
    """AC3 item 1 — `e2e --agent A -- <feature path>` passes `<feature path>`
    to the declared target's LAST `&&`-joined command, verbatim; the FIRST
    command receives none of it; the board's raw ingest is exactly one, and
    its report holds only the case matching what was asked, filed as a run
    of the e2e tier.

    RED today: argparse rejects the whole invocation (module docstring) —
    `self.fake_bun`/the recorder never run at all, so `self.invocations(...)`
    is empty and `self.raw_ingests()` is `[]`, never "the wrong case was
    filed"."""

    FEATURE_PATH = "tests/e2e/features/widget-creation.feature"

    def setUp(self):
        super().setUp()
        self.declare_e2e()

    def test_feature_argument_after_dashdash_reaches_only_the_last_command_and_files_only_its_case(self):
        result = self.drive("e2e", extra=("--", self.FEATURE_PATH))
        self.assertEqual(
            result.returncode, 0,
            f"a filtered e2e run with a real match exits 0; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}")

        noop_runs = self.invocations("noop")
        self.assertEqual(
            len(noop_runs), 1,
            f"the declared target's FIRST command must run exactly once; "
            f"ran {len(noop_runs)} time(s)")
        self.assertEqual(
            noop_runs[0], [],
            f"the FIRST `&&`-joined command must receive NONE of the "
            f"passthrough argument; got argv={noop_runs[0]!r}")

        last_runs = self.invocations("last")
        self.assertEqual(
            len(last_runs), 1,
            f"the declared target's LAST command must run exactly once; "
            f"ran {len(last_runs)} time(s)")
        self.assertEqual(
            last_runs[0], ["test", self.FEATURE_PATH],
            f"the LAST command's argv must END with exactly the feature "
            f"path passed after `--`; got {last_runs[0]!r}")

        ingests = self.raw_ingests()
        self.assertEqual(
            len(ingests), 1,
            f"exactly one raw ingest reaches the board; got {ingests!r}; "
            f"all posts={self.board.posts()!r}")
        _path, body = ingests[0]
        self.assertEqual(body.get("tier"), "e2e", f"body={body!r}")
        self.assertEqual(body.get("codec"), "playwright", f"body={body!r}")
        data_path = body.get("dataPath")
        self.assertTrue(
            data_path and os.path.exists(data_path),
            f"the dataPath the board was told to decode must exist; "
            f"body={body!r}")
        with open(data_path) as handle:
            report = json.load(handle)
        titles = [spec["title"] for spec in report["suites"][0]["specs"]]
        self.assertEqual(
            titles, [self.FEATURE_PATH],
            f"the report must hold EXACTLY the case matching what the "
            f"target was asked — not the whole suite, not zero cases; "
            f"report={report!r}")


# ── item 2 — a quoted multi-word grep value ─────────────────────────────────

class QuotedGrepArgumentSurvivesPassthroughIntactTest(_DashDashCase):
    """AC3 item 2 — `-- --grep "a title with spaces"` arrives at the
    declared target as TWO intact argv items, the value never split on its
    internal spaces.

    RED today: same argparse rejection (module docstring) — the drive never
    reaches the recorder at all."""

    GREP_TITLE = "a title with spaces"

    def setUp(self):
        super().setUp()
        self.declare_e2e()

    def test_grep_flag_and_its_quoted_value_arrive_as_two_intact_argv_items(self):
        result = self.drive("e2e", extra=("--", "--grep", self.GREP_TITLE))
        self.assertEqual(
            result.returncode, 0,
            f"stdout={result.stdout!r} stderr={result.stderr!r}")

        last_runs = self.invocations("last")
        self.assertEqual(len(last_runs), 1,
                         f"the declared target must run exactly once; "
                         f"ran {len(last_runs)} time(s)")
        self.assertEqual(
            last_runs[0], ["test", "--grep", self.GREP_TITLE],
            f"`--grep` and its quoted value must arrive as TWO intact argv "
            f"items (never split, never merged with the static leading "
            f"\"test\" token); got {last_runs[0]!r}")


# ── item 3 — no `--` at all (PIN: unchanged) ────────────────────────────────

class NoDashDashLeavesTheDeclaredTargetUnchangedTest(_DashDashCase):
    """AC3 item 3 — PIN, not RED: "without `--` it runs the whole suite, as
    today." Without `--`, the declared target receives no extra argument at
    all and the board files the WHOLE report, exactly as before this CR.

    Proven BOTH ways: (a) it passes against the CURRENT client below — this
    exact fixture, driven with no `--`, is nothing but today's unmodified
    declared-tier run, and the assertions below hold against the code as it
    stands right now (proving the fixture itself, not just the new
    behaviour, is sound — the SAME fixture plumbing backs the RED tests
    above); (b) it would FAIL against the specific regression this CR's own
    §S3 text forbids — GREEN wiring §S3's passthrough so it still appends
    something (even an empty marker) when no `--` was typed, which would
    change `last_runs[0]` away from the bare `["test"]` this test pins, or
    wiring the e2e verb to always re-run with the LAST filter it remembers,
    which would change which cases the ingested report holds."""

    def setUp(self):
        super().setUp()
        self.declare_e2e()

    def test_without_dashdash_the_target_receives_no_extra_argument_and_files_the_whole_report(self):
        result = self.drive("e2e")
        self.assertEqual(
            result.returncode, 0,
            f"stdout={result.stdout!r} stderr={result.stderr!r}")

        last_runs = self.invocations("last")
        self.assertEqual(len(last_runs), 1,
                         f"the declared target must run exactly once; "
                         f"ran {len(last_runs)} time(s)")
        self.assertEqual(
            last_runs[0], ["test"],
            f"with no `--`, the declared target's own command line is "
            f"UNCHANGED — no extra argument at all; got {last_runs[0]!r}")

        ingests = self.raw_ingests()
        self.assertEqual(len(ingests), 1, f"ingests={ingests!r}; "
                         f"all posts={self.board.posts()!r}")
        _path, body = ingests[0]
        with open(body["dataPath"]) as handle:
            report = json.load(handle)
        titles = [spec["title"] for spec in report["suites"][0]["specs"]]
        self.assertEqual(
            titles, WHOLE_SUITE_CASES,
            f"without `--`, the ingest is the WHOLE report — unchanged; "
            f"report={report!r}")


# ── item 4 — the printed invocation shows the passthrough ──────────────────

class PrintedInvocationShowsThePassthroughTest(_DashDashCase):
    """AC3 item 4 — "what ran is what is printed": the `[crucible] running:
    …` echo (`_render_invocation`, `cmd_regression`) must show the
    passthrough argument, not merely `bun run test:e2e`.

    RED today: the drive never gets past argparse (module docstring), so no
    `[crucible] running:` line is ever printed at all — `running_lines` is
    `[]`, not "printed the wrong thing"."""

    def setUp(self):
        super().setUp()
        self.declare_e2e()

    def test_printed_invocation_includes_the_passthrough_argument(self):
        feature = "tests/e2e/features/checkout.feature"
        result = self.drive("e2e", extra=("--", feature))
        self.assertEqual(
            result.returncode, 0,
            f"stdout={result.stdout!r} stderr={result.stderr!r}")

        running_lines = [line for line in result.stderr.splitlines()
                         if line.startswith("[crucible] running:")]
        self.assertTrue(
            running_lines,
            f"no `[crucible] running: …` invocation line was printed at "
            f"all; stderr={result.stderr!r}")
        self.assertIn(
            feature, running_lines[0],
            f"the printed invocation must show the passthrough argument "
            f"that actually ran — what ran is what is printed; got "
            f"{running_lines[0]!r}")


# ── item 5 — the rule is per DECLARED TIER, not e2e-only ───────────────────

class DashDashAppliesToAnyDeclaredTierNotJustE2eTest(_DashDashCase):
    """AC3 item 5 — "`-- …` on another declared tier verb behaves the same
    (the rule is per declared tier, not e2e-only)." Proven on `module`
    (tier `module`, target `test:module`), the shared
    `_add_declared_tier_args`/`add_tier_verbs` flag surface every declared
    cell takes (`clients/_crucible_axi.py: add_tier_verbs`) — never a
    second, e2e-specific argparse wiring.

    Deliberately the SAME (env/rawReport) report mechanism as `test:e2e`,
    not the flag-default mechanism this repo's real `test:unit` declares:
    under the flag mechanism `_bun_run_script_cmd` ALSO appends `bun test`'s
    own `--reporter=junit --reporter-outfile=…` tokens ahead of any `--`
    passthrough, onto the very same compound-script forwarding this CR
    turns on (the exact entanglement CR-CRU-133 introduced the env
    mechanism to avoid) — orthogonal to the passthrough contract itself, so
    proving it on a second declared target that shares `test:e2e`'s own
    mechanism isolates the ONE thing this item claims: the parser-level fix
    is shared, not hardcoded to the `e2e` verb.

    RED today: the SAME argparse rejection (module docstring) fires for
    `module … --` exactly as it does for `e2e … --` — neither verb has a
    positional to catch what follows `--`."""

    def setUp(self):
        super().setUp()
        recorder = self.write_recorder("fake-module-last", MODULE_JSON_VAR)
        _declare(self.project,
                scripts={"test:module": f"{self.fake_noop} && {recorder} test"},
                report_path={"test:module": f"env:{MODULE_JUNIT_VAR}"},
                raw_report={"test:module": {
                    "codec": "generic", "file": "module.json",
                    "path": f"env:{MODULE_JSON_VAR}"}})

    def test_dashdash_forwards_to_a_declared_module_target_too(self):
        feature = "tests/module/widgets.spec.ts"
        result = self.drive("module", extra=("--", feature))
        self.assertEqual(
            result.returncode, 0,
            f"stdout={result.stdout!r} stderr={result.stderr!r}")

        last_runs = self.invocations("last")
        self.assertEqual(len(last_runs), 1,
                         f"the declared target must run exactly once; "
                         f"ran {len(last_runs)} time(s)")
        self.assertEqual(
            last_runs[0], ["test", feature],
            f"the passthrough rule must apply to ANY declared tier, not "
            f"only e2e; got {last_runs[0]!r}")

        ingests = self.raw_ingests()
        self.assertEqual(len(ingests), 1, f"ingests={ingests!r}; "
                         f"all posts={self.board.posts()!r}")
        _path, body = ingests[0]
        self.assertEqual(
            body.get("tier"), "module",
            f"the run a declared tier files rides THAT verb's own tier; "
            f"body={body!r}")


if __name__ == "__main__":
    unittest.main()
