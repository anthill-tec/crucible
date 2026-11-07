"""A cargo-nextest older than 0.9.130, or one whose version cannot be read,
is refused on every verb of the rust client's four test-running bodies,
before anything else runs.

With an agent, the client reads `cargo nextest --version` first. Below
0.9.130 (the version the board's `nextest` decoder is proven against), or
when no version can be read, the verb is refused:
  - no run is opened on the board;
  - cargo cleans, builds and lists nothing (the version read is the only
    cargo call);
  - `pre-merge-gate` runs no clippy and `docker-e2e-gate` brings no docker up;
  - no gate lock is taken and the disk guard never measures;
  - ONE `ok: false` envelope names 0.9.130 and the version found.

A version at or past the minimum is compared as a version, never as text:
0.10.0 runs.

Driven on the shared fake cargo (FAKE_NEXTEST_VERSION) with a recording
`docker`, against a `RecordingBoard`, in a git repository so a run that
reached its gate lock would take one.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_a_rust_run_refuses_an_unsupported_nextest
"""

import json
import os
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.rust_stream_harness import (
    VERBS,
    StreamedRustProject,
    diagnostics,
    envelope,
    warning_texts,
)

# Every verb with nothing that skips a guard: `pre-merge-gate` keeps its
# clippy step and `docker-e2e-gate` its docker bring-up.
REFUSED_VERBS = dict(VERBS)
REFUSED_VERBS["pre-merge-gate"] = ("pre-merge-gate", "--min-free-g", "0", "--keep-target")
REFUSED_VERBS["docker-e2e-gate"] = ("docker-e2e-gate", "--min-free-g", "0")

VERSION_CALLS = (["nextest", "--version"], ["nextest", "-V"])

_RECORDING_DOCKER = """#!{python}
import json, os, sys
calls = os.environ.get("FAKE_DOCKER_CALLS")
if calls:
    with open(calls, "a") as handle:
        handle.write(json.dumps(sys.argv[1:]) + "\\n")
sys.exit(0)
"""


class _VersionCase(unittest.TestCase):
    maxDiff = 4000

    def project(self):
        p = StreamedRustProject(self)
        docker = Path(p.bin_dir, "docker")
        docker.write_text(_RECORDING_DOCKER.format(python=sys.executable))
        os.chmod(docker, stat.S_IRWXU)
        subprocess.run(["git", "init", "-q", p.dir], check=True)
        return p

    @staticmethod
    def docker_calls_path(p):
        return os.path.join(p.dir, "docker-calls.jsonl")

    def drive(self, p, label, version, **fake):
        return p.drive(label, verb_argv=REFUSED_VERBS[label], FAKE_TOTAL="1",
                       FAKE_NEXTEST_VERSION=version, FAKE_DOCKER_CALLS=self.docker_calls_path(p),
                       **fake)

    def docker_calls(self, p):
        path = self.docker_calls_path(p)
        if not os.path.exists(path):
            return []
        return [json.loads(line) for line in Path(path).read_text().splitlines()]

    def assert_refused_before_anything(self, p, result, label, found):
        where = (f"{label} ({found}): calls={[c['argv'] for c in p.calls()]!r} "
                 f"{diagnostics(result)}")
        self.assertNotEqual(result.returncode, 0, where)
        axi = envelope(result.stdout) or {}
        self.assertIs(axi.get("ok"), False, f"one refusal envelope; {where}")
        said = " ".join([str(axi.get("error") or "")] + warning_texts(axi))
        self.assertIn("0.9.130", said, f"the refusal names the minimum; {where}")
        if found != "unreadable":
            self.assertIn(found, said, f"the refusal names the version found; {where}")
        else:
            self.assertIn("nextest", said, f"the refusal names nextest; {where}")
        self.assertEqual(p.starts(), [], f"no run is opened; {where}")
        self.assertEqual([path for path, _b in p.posts()
                          if path.startswith("/api/v2/runs")], [],
                         f"nothing reaches a run route; {where}")
        heads = [c["argv"][:2] for c in p.calls()]
        self.assertGreaterEqual(len(heads), 1, f"the version was read; {where}")
        self.assertEqual([h for h in heads if h not in VERSION_CALLS], [],
                         f"cargo cleans, builds, lints and lists nothing; {where}")
        self.assertEqual(self.docker_calls(p), [], f"no docker is brought up; {where}")
        self.assertNotIn("gate lock created", result.stderr, f"no gate lock; {where}")
        self.assertNotIn("free /home", result.stderr, f"no disk guard; {where}")


class AnOldNextestIsRefusedOnEveryVerbTest(_VersionCase):

    def test_nextest_0_9_129_is_refused_before_anything_runs_on_every_verb(self):
        for label in REFUSED_VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = self.drive(p, label, "0.9.129")
                self.assert_refused_before_anything(p, result, label, "0.9.129")

    def test_a_nextest_whose_version_cannot_be_read_is_refused_before_anything_runs(self):
        for label in REFUSED_VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = self.drive(p, label, "unreadable")
                self.assert_refused_before_anything(p, result, label, "unreadable")

    def test_the_version_is_read_before_any_other_cargo_call(self):
        for label in VERBS:
            with self.subTest(verb=label):
                p = self.project()
                result = p.drive(label, FAKE_TOTAL="1")
                heads = [c["argv"][:2] for c in p.calls()]
                self.assertGreaterEqual(len(heads), 2, f"{label}: {diagnostics(result)}")
                self.assertIn(heads[0], VERSION_CALLS,
                              f"{label}: the first cargo call reads the version; calls={heads!r}")


class ASupportedNextestRunsTest(_VersionCase):

    def test_nextest_0_9_130_and_0_10_0_run_and_stream(self):
        for version in ("0.9.130", "0.10.0"):
            for label in ("test", "regression-ingest", "smoke-test", "workspace-regression"):
                with self.subTest(verb=label, version=version):
                    p = self.project()
                    result = self.drive(p, label, version)
                    where = f"{label} ({version}): {diagnostics(result)}"
                    self.assertEqual(len(p.starts()), 1, f"the run is opened; {where}")
                    self.assertEqual(len(p.calls_of("nextest", "run")), 1, where)
                    self.assertEqual([b.get("codec") for _p, b in p.board.stream_posts()][:1],
                                     ["nextest"], f"the run streams; {where}")


if __name__ == "__main__":
    unittest.main()
