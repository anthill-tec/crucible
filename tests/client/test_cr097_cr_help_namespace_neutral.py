"""CR-CRU-097 §S2/§S4 (cycle 315) -- no `--cr` help string in any of the five
clients may name ANY project's CR namespace.

AC2 (verbatim): "No `--cr` help string in any of the five clients names **any
project's** CR namespace. Stated per-namespace, not per-literal: four clients
carry `CR-CRU-008` and `rust-crucible.py:2413` carries `CR-NAI-203`, so a
criterion naming only `CR-CRU-` would ship green over the fifth. The help line
teaches the SHAPE of a caller-owned free-text key and names no real project."

WHY the assertion is namespace-AGNOSTIC (`CR-[A-Z]{2,}-\\d+`) rather than a
`CR-CRU-` literal: §S2 measured the fleet and found the fifth client leaking a
DIFFERENT real project's ids (`CR-NAI-203`), so the defect class is "some real
project's ids", not "our ids". A literal criterion would have shipped green
over `rust-crucible.py`.

WHAT IS DRIVEN: the verb that carries the offending `--cr` -- `plan-file` --
is invoked for real (`plan-file --help`) on each of the five clients and its
ACTUAL stdout is asserted. Nothing here reads client SOURCE: a regex over
`clients/*.py` would also flag the ~618 legitimate provenance COMMENTS the CR
leaves untouched, and would not prove what a user actually sees.

NOT IN SCOPE (stated so a later reader does not "fix" them): `--crs` and
`milestone --cr` (`help="CR id (rides context.cr)."`) name no namespace and
are already compliant.

NON-VACUITY: "the help text contains no CR id" passes trivially on an empty
string (a mis-spelled verb, an argparse error, a client that failed to load),
so each check first pins that the help really rendered -- exit 0, non-empty,
and carrying the `--cr` flag it is about.

Module-loading convention: REPO_ROOT-relative `clients/*.py`, loaded by file
path (hyphenated filenames), and `main()` driven with `sys.argv` patched --
the SAME idiom as every sibling harness here (`test_cr061_gate_run_skip_
passthrough.py`, `test_cr054_drift_guard.py`, ...).

RED phase: every test below fails against TODAY's tree --
`arduino-crucible.py:1079`, `bun-crucible.py:1963`, `mvn-crucible.py:1896`,
`python-crucible.py:1352` render `CR id, e.g. CR-CRU-008.` and
`rust-crucible.py:2413` renders `CR id, e.g. CR-NAI-203.`

Invocation:
    python3 -m pytest tests/client/test_cr097_cr_help_namespace_neutral.py -q
Fallback:
    python3 tests/client/test_cr097_cr_help_namespace_neutral.py
"""

import contextlib
import importlib.util
import io
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}

# The verb carrying the offending `--cr` (§S2).
CR_VERB = "plan-file"

# Any real project's CR id shape. Namespace-agnostic BY DESIGN (AC2).
ANY_PROJECT_CR = re.compile(r"CR-[A-Z]{2,}-\d+")

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _load_client_module(name):
    path = CLIENT_FILES[name]
    if not path.exists():
        raise unittest.SkipTest(f"{path} not found")
    spec = importlib.util.spec_from_file_location(
        f"cr097_cr_help_{name}_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv, prog):
    """Invoke `module.main()` with `sys.argv` patched. Only `SystemExit` is
    caught -- `--help` exits 0 through it -- so any OTHER exception surfaces
    as a genuine unittest ERROR."""
    stdout = io.StringIO()
    stderr = io.StringIO()
    with mock.patch.object(sys, "argv", [prog] + argv):
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


def _plan_file_help(name):
    """The client's REAL `plan-file --help` output."""
    module = _load_client_module(name)
    code, out, err = _run_main(
        module, [CR_VERB, "--help"], str(CLIENT_FILES[name]))
    return code, _ANSI.sub("", out + err)


class PlanFileCrHelpNamesNoProjectNamespaceTest(unittest.TestCase):
    """AC2 -- the shipped `--cr` help line, on every client."""

    def test_plan_file_help_renders_on_every_client(self):
        """NON-VACUITY for the whole file: `plan-file --help` must actually
        exit 0, print something, and document `--cr` on all five clients.
        Without this, the namespace assertion below could pass because the
        invocation broke rather than because the copy is clean."""
        offenders = {}
        for name in sorted(CLIENT_FILES):
            code, help_text = _plan_file_help(name)
            problems = []
            if code != 0:
                problems.append(f"exit {code}")
            if not help_text.strip():
                problems.append("empty help output")
            if "--cr" not in help_text:
                problems.append("no --cr flag documented")
            if problems:
                offenders[name] = f"{problems} :: {help_text[:400]!r}"
        self.assertEqual(
            offenders, {},
            f"`{CR_VERB} --help` must render and document --cr on every "
            f"client (non-vacuity guard); offenders: {offenders}")

    def test_no_client_plan_file_help_names_any_projects_cr_namespace(self):
        """AC2 -- `CR-<NAMESPACE>-<n>` is not a shape Crucible validates; the
        help teaches a caller-owned free-text key, so it may name no real
        project -- ours (`CR-CRU-008`) or anyone else's (`CR-NAI-203`)."""
        offenders = {}
        for name in sorted(CLIENT_FILES):
            code, help_text = _plan_file_help(name)
            # Non-vacuity, per client: this help really rendered.
            self.assertEqual(
                0, code,
                f"{name}: `{CR_VERB} --help` must exit 0; got {code} :: "
                f"{help_text[:400]!r}")
            self.assertIn(
                "--cr", help_text,
                f"{name}: `{CR_VERB} --help` must document --cr, else the "
                f"namespace assertion is vacuous :: {help_text[:400]!r}")
            found = sorted(set(ANY_PROJECT_CR.findall(help_text)))
            if found:
                offenders[name] = found
        self.assertEqual(
            offenders, {},
            f"No client's `{CR_VERB} --help` may name any project's CR "
            f"namespace (AC2); leaked ids by client: {offenders}")


if __name__ == "__main__":
    unittest.main()
