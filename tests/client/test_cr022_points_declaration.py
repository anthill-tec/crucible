# CR-CRU-022 RED note: `_PointsVerbTestBase`/`_PointsWireTests` are a plain
# multiple-inheritance MIXIN pair (test_cr091_roadmap_verbs.py's own shape,
# deliberately NOT inheriting unittest.TestCase individually so discovery
# never collects the abstract halves — that used to be a TestCase whose
# setUpClass raised SkipTest("abstract base"), leaving one permanent phantom
# `skipped` in every Python suite run). A static checker cannot see the
# attributes each mixin borrows from its sibling until they are combined in
# the five concrete `unittest.TestCase` subclasses below, where they are
# real; this repo-wide, established pattern is the reason for the pragma.
# pyright: reportAttributeAccessIssue=false, reportArgumentType=false, reportOptionalMemberAccess=false
"""RED — CR-CRU-022 §S1/AC2: `cr-plan --points N` across the fleet.

Spec: docs/changes/CR-CRU-022-roadmap-analytics.md §S1 (second bullet) +
its AC block's second item — "--points appears on all five stack clients
through the shared _crucible_axi.py, asserted once per client — not
re-implemented per client."

The implementation lands ONCE in `clients/_crucible_axi.py` (the
CR-CRU-054 DRY rule), inside the ALREADY-shared `add_roadmap_verbs`'s
`cr-plan` subparser (`_crucible_axi.py:4199-4214`) and its delegator
`cmd_cr_plan` (`_crucible_axi.py:3831-3866`) — so wiring `--points` there
reaches all five clients "for free"; this file drives all five real
`main()` entry points through a recording `_post`/`_get` stub (the fleet's
established harness idiom — `tests/client/test_cr091_roadmap_verbs.py`)
to prove that is actually true, and never re-implements the flag per
client.

Measured baseline (2026-09-24, re-confirmed at this RED pass): `grep -n
'"--points"' clients/_crucible_axi.py` returns ZERO matches — `cr-plan`'s
subparser adds only `--cr`, `--title`, `--release`, `--wave` plus the
shared roadmap-projection/common args (`_crucible_axi.py:4204-4214`).
Every client's `cr-plan` argv here is expected to fail with argparse's
`unrecognized arguments: --points N` (SystemExit(2)), so `_post` never
fires and every "wire shape" assertion below fails for that reason — the
intended RED signal.

What is DELIBERATELY NOT asserted here (server-side, not the client's job,
and left to tests/cr022-story-points.test.ts): whether the value is
refused for landing off the 1-2-3-5-8-13 Fibonacci scale. §S1's ruling —
"any other value is refused, naming the scale" — matches the codebase's
existing precedent for value-shape refusals (e.g. `release`'s string-type
check lives server-side in `handleCrPlan`, not client-side), so this file
tests only the WIRE half: `--points N` reaches `cr-plan`'s POST body
verbatim as the integer N, and an omitted `--points` sends no `points` key
at all (never a fabricated default).
"""

import contextlib
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.test_client_fleet_envelope_census import install_project_limits

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
TOON_PATH = CLIENTS_DIR / "toon.py"
SHARED_PATH = CLIENTS_DIR / "_crucible_axi.py"

CLIENT_FILES = {
    "python": CLIENTS_DIR / "python-crucible.py",
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}

PROJECT_KEY = "cr022-points-key"
PLAN_PATH = f"/api/v2/projects/{PROJECT_KEY}/queue/plan"

# The env keys the fleet's `context` block reads — cleared so an ambient
# orchestrator session can never colour an envelope this file asserts on
# (test_cr091_roadmap_verbs.py's own precaution).
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_PROJECT_NAME")


def _load_module(path, name):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke `module.main()` with sys.argv patched → (code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with mock.patch.object(sys, "argv", ["client"] + argv), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


class _PointsVerbTestBase:
    """A plain MIXIN (test_cr091_roadmap_verbs.py's shape, C3's own fix for
    the SkipTest-abstract-base phantom): only the five concrete per-client
    classes below inherit `unittest.TestCase`, so discovery never collects
    this abstract class."""

    CLIENT = None

    def setUp(self):
        self.module = _load_module(CLIENT_FILES[self.CLIENT], f"cr022_{self.CLIENT}_under_test")
        self.toon = _load_module(TOON_PATH, "cr022_toon_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix=f"cr022-{self.CLIENT}-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
            # arduino's `_load_env` requires the name too; harmless elsewhere.
            fh.write("CRUCIBLE_PROJECT_NAME=cr022-points-project\n")
        install_project_limits(self.tmpdir)
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def drive(self, argv, post_return=None):
        post_return = post_return if post_return is not None else {
            "ok": True, "converged": False, "entry": {"cr": "CR-X"},
            "warnings": [], "unknownDependencies": []}
        argv = argv + ["--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_post", return_value=post_return,
                               create=True) as post_mock, \
                mock.patch.object(self.module, "_get",
                                  return_value={"ok": True, "proposals": [], "totalCount": 0},
                                  create=True), \
                mock.patch.object(self.module, "_patch", return_value=None, create=True):
            code, out, err = _run_main(self.module, argv)
        self.stdout_text, self.stderr_text = out, err
        return code, out, post_mock

    def assert_posted(self, post_mock, path):
        for call in post_mock.call_args_list:
            args, kwargs = call
            called = args[0] if args else kwargs.get("path")
            if called == path:
                return call[0][1]
        self.fail(
            f"{self.CLIENT}: nothing was POSTed to {path} — cr-plan --points "
            f"either does not exist as a flag yet or never reached the "
            f"wire; calls={post_mock.call_args_list!r} stderr="
            f"{self.stderr_text!r}")


class _PointsWireTests:
    """§S1/AC1+AC2 — `--points N` reaches `cr-plan`'s POST body verbatim, as
    an integer, on every client."""

    def test_cr_plan_points_reaches_the_wire_as_an_integer(self):
        code, _out, post_mock = self.drive(
            ["cr-plan", "--cr", "CR-CRU-200", "--release", "0.4.0",
             "--wave", "3", "--title", "pointed cr", "--points", "5",
             "--agent", "orc"])
        self.assertEqual(
            code, 0,
            f"{self.CLIENT}: cr-plan --points 5 should succeed against the "
            f"recording stub; stderr={self.stderr_text!r}")
        body = self.assert_posted(post_mock, PLAN_PATH)
        self.assertEqual(
            body.get("points"), 5,
            f"{self.CLIENT}: --points 5 must reach cr-plan's POST body as "
            f"the INTEGER 5 (§S1); got {body!r}")

    def test_cr_plan_without_points_omits_the_field_from_the_wire(self):
        _code, _out, post_mock = self.drive(
            ["cr-plan", "--cr", "CR-CRU-201", "--release", "0.4.0",
             "--wave", "3", "--title", "unpointed cr", "--agent", "orc"])
        body = self.assert_posted(post_mock, PLAN_PATH)
        self.assertNotIn(
            "points", body,
            f"{self.CLIENT}: an unpointed cr-plan call must send NO "
            f"`points` key at all — never a fabricated default (§S1); "
            f"got {body!r}")
        # A pointed SIBLING call must carry it — proves the omission above
        # is a real per-call fact rather than "points never reaches the
        # wire at all", which would make the assertion above vacuously true
        # before --points even exists as a flag.
        _code2, _out2, post_mock2 = self.drive(
            ["cr-plan", "--cr", "CR-CRU-201B", "--release", "0.4.0",
             "--wave", "3", "--title", "pointed sibling", "--points", "5",
             "--agent", "orc"])
        body2 = self.assert_posted(post_mock2, PLAN_PATH)
        self.assertEqual(body2.get("points"), 5)

    def test_cr_plan_points_across_the_fibonacci_scale(self):
        for value in (1, 2, 3, 5, 8, 13):
            with self.subTest(points=value):
                _code, _out, post_mock = self.drive(
                    ["cr-plan", "--cr", "CR-CRU-202", "--release", "0.4.0",
                     "--wave", "3", "--title", "scale cr",
                     "--points", str(value), "--agent", "orc"])
                body = self.assert_posted(post_mock, PLAN_PATH)
                self.assertEqual(
                    body.get("points"), value,
                    f"{self.CLIENT}: --points {value} must reach the wire "
                    f"as {value!r}; got {body!r}")


class _AllPointsVerbTests(_PointsWireTests, _PointsVerbTestBase):
    """Every mixin above, bound to one client by the five subclasses below."""


class PythonPointsVerbTest(_AllPointsVerbTests, unittest.TestCase):
    CLIENT = "python"


class BunPointsVerbTest(_AllPointsVerbTests, unittest.TestCase):
    CLIENT = "bun"


class RustPointsVerbTest(_AllPointsVerbTests, unittest.TestCase):
    CLIENT = "rust"


class MvnPointsVerbTest(_AllPointsVerbTests, unittest.TestCase):
    CLIENT = "mvn"


class ArduinoPointsVerbTest(_AllPointsVerbTests, unittest.TestCase):
    CLIENT = "arduino"


# ═══════════════════════════════════════════════════════════════════════════
# §S1/AC2 / §S9 — the implementation lands ONCE
# ═══════════════════════════════════════════════════════════════════════════


class PointsFlagLandsOnceTest(unittest.TestCase):
    """CR-CRU-054's DRY rule, applied to `--points`: it must be added to
    `cr-plan`'s parser ONCE, in the shared `add_roadmap_verbs`
    (`_crucible_axi.py`), never re-implemented per client."""

    def test_points_flag_is_registered_exactly_once_in_the_shared_module(self):
        source = SHARED_PATH.read_text()
        occurrences = source.count('"--points"')
        self.assertEqual(
            occurrences, 1,
            f"§S1/AC2 — `--points` must be added to cr-plan's parser "
            f"exactly ONCE, in the shared add_roadmap_verbs (§S9 DRY "
            f"rule); found {occurrences} occurrence(s) of \"--points\" in "
            f"_crucible_axi.py")


if __name__ == "__main__":
    unittest.main()
