"""A Go toolchain older than 1.24 is refused before anything runs.

Go 1.24 is the first whose `go test -json` writes `build-output` /
`build-fail`, which the board's `go-test` codec reads. Below it the go
client's `test` refuses before running: no `go test` call (no list, no run),
no run opened on the board, and ONE `ok: false` envelope naming the version
found and the floor. A version is compared as a version, never as text: Go 1.9
is older than 1.24, and Go 1.24.0 runs.

The version is injected through the recording shim (`GO_SHIM_VERSION`), which
answers both `go version` and `go env GOVERSION`; a refused version runs with
`GO_SHIM_FAKE_ONLY`, so a client that ran anyway would run nothing real.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_go_older_than_the_floor_is_refused
"""

import unittest

from tests.client.go_client_harness import (
    GoProject,
    diagnostics,
    envelope,
    go_toolchain_gap,
    said,
)


class AGoBelowTheFloorIsRefusedTest(unittest.TestCase):
    maxDiff = 4000

    def assert_refused(self, version, shown):
        p = GoProject(self)
        result = p.drive(GO_SHIM_VERSION=version, GO_SHIM_FAKE_ONLY="1")
        where = f"{version}: calls={[c['argv'] for c in p.calls()]!r} {diagnostics(result)}"
        self.assertNotEqual(result.returncode, 0, f"the run is refused; {where}")
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {where}")
        self.assertEqual((axi or {}).get("verb"), "test", where)
        self.assertIs((axi or {}).get("ok"), False, where)
        words = said(axi)
        self.assertIn(shown, words, f"the refusal names the version found; {where}")
        self.assertIn("1.24", words, f"the refusal names the floor; {where}")
        self.assertEqual(p.test_calls(), [], f"go lists and runs nothing; {where}")
        self.assertEqual(p.run_route_posts(), [], f"no run is opened; {where}")

    def test_go_1_23_4_is_refused_before_running_naming_the_version(self):
        self.assert_refused("go1.23.4", "1.23.4")

    def test_go_1_9_is_older_than_1_24_and_is_refused(self):
        self.assert_refused("go1.9.7", "1.9.7")


class AGoAtTheFloorRunsTest(unittest.TestCase):

    def setUp(self):
        gap = go_toolchain_gap()
        if gap:
            self.fail(f"missing toolchain: {gap}")

    def test_go_1_24_0_runs_and_streams(self):
        p = GoProject(self)
        p.board.script_run(passed=10, failed=5, pending=2)
        result = p.drive(GO_SHIM_VERSION="go1.24.0")
        where = diagnostics(result)
        self.assertEqual(len(p.starts()), 1, f"the run is opened; {where}")
        self.assertEqual(len(p.run_calls()), 1, f"the tests run; {where}")
        self.assertEqual([b.get("codec") for _p, b in p.board.stream_posts()][:1],
                         ["go-test"], f"the run streams; {where}")


if __name__ == "__main__":
    unittest.main()
