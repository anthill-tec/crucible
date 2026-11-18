"""A rust project declares its runs in its own `crucible.toml` as
`[targets.<nextest profile>]`, in bun's `crucible.targets` vocabulary:
`framework = "nextest"` and `stream = { codec = "nextest", path = "stdout" }`.

These stream as declared:
  - a project with no `crucible.toml` of its own;
  - a project whose `crucible.toml` has no entry for the run's profile;
  - a project declaring the exact entry;
  - a project whose install-level `crucible.toml` declares a different entry
    (only the project's own file declares, so it is ignored).

Each of these is refused with nothing run (no run opened; cargo cleans,
builds and lists nothing; no clippy, no docker, no gate lock), the refusal
naming `targets.<profile>` and the field at fault where an entry is at fault:
  - an entry naming another `framework`, `codec` or `path`;
  - an entry declaring `junit`, `console` or `coverage`;
  - a project `crucible.toml` that does not parse;
  - a board whose health does not list `nextest` under `codecs.stream`.

JUnit no longer declares a tier: a tier profile in `.config/nextest.toml`
with no `junit` table counts as declared, for the tier verb and for the
scoped `pre-merge-gate`.

Driven on the shared fake cargo against a `RecordingBoard`. A project with no
file of its own, or one whose file does not parse, runs a COPIED install
whose own `crucible.toml` points at that board, so no drive can resolve the
checkout's configuration.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_rust_run_reads_its_projects_targets_declaration
"""

import os
import shutil
import subprocess
import unittest
from pathlib import Path

from tests.client.live_run_harness import CLIENTS, RecordingBoard, board_health
from tests.client.rust_stream_harness import (
    RUN_ID,
    VERBS,
    StreamedRustProject,
    diagnostics,
    envelope,
    warning_texts,
)

# One verb of each body, and the profile each runs.
BODY_VERBS = {"test": "ci", "regression-ingest": "ci", "smoke-test": "ci",
              "workspace-regression": "ci", "e2e": "e2e"}

EXACT_ENTRY = ('framework = "nextest"\n'
               'stream = { codec = "nextest", path = "stdout" }\n')

# Entry bodies refused, each with the field the refusal names.
REFUSED_ENTRIES = {
    "framework": ('framework = "cargo-test"\n'
                  'stream = { codec = "nextest", path = "stdout" }\n'),
    "codec": ('framework = "nextest"\n'
              'stream = { codec = "crucible-events", path = "stdout" }\n'),
    "path": ('framework = "nextest"\n'
             'stream = { codec = "nextest", path = "env:CRUCIBLE_STREAM" }\n'),
    "junit": EXACT_ENTRY + 'junit = "flag"\n',
    "console": EXACT_ENTRY + 'console = "bun-console"\n',
    "coverage": EXACT_ENTRY + 'coverage = "lcov"\n',
}


def _client_table(board_url):
    return f'[client]\nurl = "{board_url}"\n'


class _DeclarationCase(unittest.TestCase):
    maxDiff = 4000

    def project(self, **options):
        p = StreamedRustProject(self, **options)
        subprocess.run(["git", "init", "-q", p.dir], check=True)
        return p

    def write_project_toml(self, p, text):
        Path(p.dir, "crucible.toml").write_text(_client_table(p.board.url) + text)

    def copied_install(self, p, install_toml):
        """A copy of the clients whose install-level `crucible.toml` is
        `install_toml`; returns the copied rust client's path."""
        install = os.path.join(p.dir, "install")
        shutil.copytree(CLIENTS, os.path.join(install, "clients"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        Path(install, "crucible.toml").write_text(install_toml)
        return os.path.join(install, "clients", "rust-crucible.py")

    def drive_with(self, p, client, label, **fake):
        argv = p.argv(label)
        argv[1] = client
        return subprocess.run(argv, cwd=p.dir, env=p.env(FAKE_TOTAL="1", **fake),
                              capture_output=True, text=True, timeout=90, check=False)

    def assert_streamed(self, p, result, where):
        closes = p.closes()
        self.assertEqual([c.get("codec") for c in closes], ["nextest"],
                         f"the run is closed from its nextest stream; {where} "
                         f"{diagnostics(result)}")
        self.assertEqual([b.get("codec") for _p, b in p.board.stream_posts()][:1],
                         ["nextest"], f"the run streamed; {where}")

    def assert_refused(self, p, result, where, *named):
        detail = f"{where}: calls={[c['argv'] for c in p.calls()]!r} {diagnostics(result)}"
        self.assertNotEqual(result.returncode, 0, detail)
        axi = envelope(result.stdout) or {}
        self.assertIs(axi.get("ok"), False, f"one refusal envelope; {detail}")
        said = " ".join([str(axi.get("error") or "")] + warning_texts(axi))
        for text in named:
            self.assertIn(text, said, f"the refusal names {text!r}; {detail}")
        self.assertEqual(p.starts(), [], f"no run is opened; {detail}")
        ran = [c["argv"][:2] for c in p.calls()
               if c["argv"][:2] not in (["nextest", "--version"], ["nextest", "-V"])]
        self.assertEqual(ran, [], f"cargo cleans, builds and lists nothing; {detail}")
        self.assertNotIn("gate lock created", result.stderr, detail)


class DeclaredOrUndeclaredProjectsStreamTest(_DeclarationCase):

    def test_a_project_with_no_crucible_toml_of_its_own_streams(self):
        for label in BODY_VERBS:
            with self.subTest(verb=label):
                p = self.project()
                os.remove(os.path.join(p.dir, "crucible.toml"))
                client = self.copied_install(p, _client_table(p.board.url))
                result = self.drive_with(p, client, label)
                self.assert_streamed(p, result, label)

    def test_a_project_with_no_entry_for_the_runs_profile_streams(self):
        for label in BODY_VERBS:
            with self.subTest(verb=label):
                p = self.project()
                self.write_project_toml(p, "\n[targets.nightly]\n" + EXACT_ENTRY)
                result = p.drive(label, FAKE_TOTAL="1")
                self.assert_streamed(p, result, label)

    def test_a_project_declaring_the_exact_entry_for_its_profile_streams(self):
        for label, profile in BODY_VERBS.items():
            with self.subTest(verb=label):
                p = self.project()
                self.write_project_toml(p, f"\n[targets.{profile}]\n" + EXACT_ENTRY)
                result = p.drive(label, FAKE_TOTAL="1")
                self.assert_streamed(p, result, label)

    def test_an_install_level_entry_is_ignored(self):
        for label, profile in BODY_VERBS.items():
            with self.subTest(verb=label):
                p = self.project()
                os.remove(os.path.join(p.dir, "crucible.toml"))
                client = self.copied_install(
                    p, _client_table(p.board.url) + f"\n[targets.{profile}]\n"
                    + REFUSED_ENTRIES["framework"])
                result = self.drive_with(p, client, label)
                self.assert_streamed(p, result, label)


class ARefusedDeclarationRunsNothingTest(_DeclarationCase):

    def test_an_entry_at_fault_is_refused_naming_its_table_and_field(self):
        for field, entry in REFUSED_ENTRIES.items():
            for label, profile in BODY_VERBS.items():
                with self.subTest(verb=label, field=field):
                    p = self.project()
                    self.write_project_toml(p, f"\n[targets.{profile}]\n" + entry)
                    result = p.drive(label, FAKE_TOTAL="1")
                    self.assert_refused(p, result, f"{label} {field}",
                                        f"targets.{profile}", field)

    def test_a_project_crucible_toml_that_does_not_parse_is_refused(self):
        for label in BODY_VERBS:
            with self.subTest(verb=label):
                p = self.project()
                Path(p.dir, "crucible.toml").write_text(
                    "[targets.ci\nframework = nextest\n")
                client = self.copied_install(p, _client_table(p.board.url))
                result = self.drive_with(p, client, label)
                self.assert_refused(p, result, label, "crucible.toml")

    def test_a_board_whose_health_lists_no_nextest_stream_codec_is_refused(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project(board=RecordingBoard(nextest_stream=False))
                result = p.drive(label, FAKE_TOTAL="1")
                self.assert_refused(p, result, label, "nextest", "codecs.stream")


class JUnitNoLongerDeclaresATierTest(_DeclarationCase):
    """`module` is rust's declared tier: a profile named for it in
    `.config/nextest.toml`, here with no `junit` table at all."""

    NEXTEST_TOML = ("[profile.default]\n[profile.ci]\n"
                    "[profile.module]\ndefault-filter = \"all()\"\n")

    def test_a_tier_profile_with_no_junit_table_is_declared_for_its_tier_verb(self):
        p = self.project(nextest_toml=self.NEXTEST_TOML)
        result = p.drive("module", verb_argv=("module",), FAKE_TOTAL="2")
        where = diagnostics(result)
        runs = p.calls_of("nextest", "run")
        self.assertEqual(len(runs), 1, f"the declared tier runs; {where}")
        argv = runs[0]["argv"]
        self.assertTrue(any(argv[i] in ("-P", "--profile") and argv[i + 1] == "module"
                            for i in range(len(argv) - 1)), f"argv={argv!r}")
        self.assertEqual([s.get("tier") for s in p.starts()], ["module"], where)
        self.assert_streamed(p, result, "module")

    # A board that records a gate's scope and suites, so a scoped gate is
    # taken up to its declaration check, and the cycle the gate belongs to.
    GATE_CAPABLE_MILESTONES = {"gate": ["scope", "suites"]}
    GATE_CYCLE = "879"

    def test_a_tier_profile_with_no_junit_table_is_declared_for_the_scoped_pre_merge_gate(self):
        p = self.project(nextest_toml=self.NEXTEST_TOML)
        health = board_health()
        health["milestones"] = dict(self.GATE_CAPABLE_MILESTONES)
        p.board.script_health(health)
        result = p.drive("pre-merge-gate",
                         verb_argv=("pre-merge-gate", "--skip-clippy", "--min-free-g", "0",
                                    "--keep-target", "--suites", "module",
                                    "--cycle", self.GATE_CYCLE),
                         FAKE_TOTAL="2")
        where = diagnostics(result)
        axi = envelope(result.stdout) or {}
        self.assertNotIn("not declared", " ".join(warning_texts(axi)) + str(axi.get("error")),
                         f"the scoped gate takes the profile as declared; {where}")
        self.assertGreaterEqual(len(p.calls_of("nextest", "run")), 1,
                                f"the scoped gate runs its suite; {where}")
        self.assertIn(RUN_ID, [b.get("runId") for b in p.closes()], where)


if __name__ == "__main__":
    unittest.main()
