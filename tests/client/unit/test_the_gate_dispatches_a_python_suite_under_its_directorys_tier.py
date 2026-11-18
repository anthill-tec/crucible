"""The gate's python translation names the tier a suite's start directory
declares.

A gate that composes a project's declared suites hands each python-owned
`python3 -m unittest discover -s <dir> ...` declaration to the python client
(`sibling_client_argv` -> `_python_suite_argv`, in the shared module). The
TOKEN AFTER THE CLIENT PATH is the verb that client runs, and the verb is the
tier the run is filed under:

  * a start directory whose LAST component names a tier the gate covers -- a
    tier of `TIER_MEANINGS` that is neither `regression` nor one of
    `GATE_UNCOVERED_TIERS` -- runs that tier's verb;
  * every other start directory (`.../e2e` included) keeps `regression`;
  * a discovery with no start directory is not dispatchable (None);
  * a script that already invokes the python client runs as declared.

The declared `--start-dir` and `--pattern` pass through unchanged, `-t` is
dropped, and the gate's `--agent`, `--release` and `--cycle` ride on the
dispatched run when the gate was given them, and only then.

TIER: `unit`. The translation is a pure function of the declaration: each
test loads the shared module in process from the test install and calls it.
No process, no socket, no wait.

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> \
        --tests tests.client.unit.test_the_gate_dispatches_a_python_suite_under_its_directorys_tier
"""

import os
import unittest

from tests.client import load_client

AXI = load_client("_crucible_axi.py")

PYTHON_CLIENT = os.path.join(AXI.clients_dir(), "python-crucible.py")
INTERPRETER = "python3"
PATTERN = "'test_*.py'"
DECLARED_PATTERN = "test_*.py"

AGENT = "gate-dispatch-agent"
RELEASE = "9.9.9"
CYCLE = 4242

# The declaration table: the start directory a project's script declares, and
# the client verb (= the tier) the gate's dispatched run must take for it.
TIER_ROWS = (
    ("tests/client/unit", "unit"),
    ("tests/client/unit/", "unit"),
    ("./tests/client/unit", "unit"),
    ("tests/client/integration", "integration"),
    ("tests/client/module", "module"),
    ("tests/client/bdd", "bdd"),
)
REGRESSION_ROWS = (
    "tests/client/e2e",
    "tests/client/regression",
    "tests/client",
    ".",
    "tests/unit_helpers",
)


def _declared(start_dir, *, pattern=True, top_level=True):
    """The script body a project declares for a python suite over `start_dir`."""
    command = f"{INTERPRETER} -m unittest discover -s {start_dir}"
    if pattern:
        command += f" -p {PATTERN}"
    if top_level:
        command += " -t ."
    return command


def _covered_tiers():
    """The tiers the gate covers, read from the shared vocabulary itself."""
    return (set(AXI.TIER_MEANINGS) - {"regression"}
            - set(AXI.GATE_UNCOVERED_TIERS))


class PythonSuiteDispatchTierTest(unittest.TestCase):
    """`sibling_client_argv("python", <discovery>, ...)` invokes the python
    client's own verb for the tier the start directory names."""

    def _dispatch(self, command, **given):
        return AXI.sibling_client_argv("python", command, **given)

    def _flags(self, argv):
        """The `--flag value` pairs after the verb, as a mapping. Every token
        after the verb is a flag followed by its value, and no flag repeats."""
        tail = argv[3:]
        self.assertEqual(
            len(tail) % 2, 0,
            f"the dispatched invocation's flags come in --flag value pairs; "
            f"got {argv!r}")
        pairs = list(zip(tail[0::2], tail[1::2], strict=True))
        names = [name for name, _value in pairs]
        self.assertTrue(
            all(name.startswith("--") for name in names),
            f"every token after the verb is a client flag and its value; "
            f"got {argv!r}")
        self.assertEqual(
            len(names), len(set(names)),
            f"no flag is passed twice; got {argv!r}")
        return dict(pairs)

    def assertDispatchedVerb(self, argv, verb, command):
        self.assertIsNotNone(
            argv, f"the declaration {command!r} is dispatchable, and the gate "
                  f"answered None for it")
        self.assertEqual(
            argv[:3], [INTERPRETER, PYTHON_CLIENT, verb],
            f"the declaration {command!r} is dispatched to the python client's "
            f"`{verb}` verb, under the declaration's own interpreter; got "
            f"{argv!r}")

    # ── the tier rows ─────────────────────────────────────────────────────

    def test_a_start_directory_naming_a_covered_tier_dispatches_that_tiers_verb(self):
        for start_dir, verb in TIER_ROWS:
            with self.subTest(start_dir=start_dir):
                command = _declared(start_dir)
                argv = self._dispatch(command, agent=AGENT, release=RELEASE,
                                      cycle=CYCLE)
                self.assertDispatchedVerb(argv, verb, command)
                self.assertEqual(
                    self._flags(argv),
                    {"--start-dir": start_dir, "--pattern": DECLARED_PATTERN,
                     "--agent": AGENT, "--release": RELEASE,
                     "--cycle": str(CYCLE)},
                    f"the declared start directory and pattern pass through "
                    f"exactly as declared, `-t` is dropped, and the gate's "
                    f"agent, release and cycle ride on the run; got {argv!r}")

    def test_a_tier_dispatch_carries_no_gate_flag_the_gate_was_not_given(self):
        for start_dir, verb in TIER_ROWS:
            with self.subTest(start_dir=start_dir):
                command = _declared(start_dir)
                argv = self._dispatch(command)
                self.assertDispatchedVerb(argv, verb, command)
                self.assertEqual(
                    self._flags(argv),
                    {"--start-dir": start_dir, "--pattern": DECLARED_PATTERN},
                    f"with no agent, release or cycle given, the dispatched run "
                    f"carries none of them; got {argv!r}")

    def test_a_tier_dispatch_without_a_declared_pattern_passes_no_pattern(self):
        command = _declared("tests/client/integration", pattern=False)
        argv = self._dispatch(command, agent=AGENT)
        self.assertDispatchedVerb(argv, "integration", command)
        self.assertEqual(
            self._flags(argv),
            {"--start-dir": "tests/client/integration", "--agent": AGENT},
            f"a declaration that states no pattern dispatches none; got {argv!r}")

    def test_every_tier_the_gate_covers_is_dispatched_under_its_own_verb(self):
        covered = _covered_tiers()
        self.assertEqual(
            {verb for _start_dir, verb in TIER_ROWS}, covered,
            "the declaration table's tier rows are exactly the tiers the gate "
            "covers, as the shared vocabulary defines them")
        for tier in sorted(covered):
            with self.subTest(tier=tier):
                command = _declared(f"tests/client/{tier}")
                argv = self._dispatch(command, cycle=CYCLE)
                self.assertDispatchedVerb(argv, tier, command)

    # ── the regression rows ───────────────────────────────────────────────

    def test_a_start_directory_naming_no_covered_tier_keeps_regression(self):
        for start_dir in REGRESSION_ROWS:
            with self.subTest(start_dir=start_dir):
                command = _declared(start_dir)
                argv = self._dispatch(command, agent=AGENT, release=RELEASE,
                                      cycle=CYCLE)
                self.assertDispatchedVerb(argv, "regression", command)
                self.assertEqual(
                    self._flags(argv),
                    {"--start-dir": start_dir, "--pattern": DECLARED_PATTERN,
                     "--agent": AGENT, "--release": RELEASE,
                     "--cycle": str(CYCLE)},
                    f"a regression dispatch passes the declaration and the "
                    f"gate's flags as before; got {argv!r}")

    def test_a_tier_the_gate_does_not_cover_keeps_regression(self):
        for tier in sorted(set(AXI.GATE_UNCOVERED_TIERS) | {"regression"}):
            with self.subTest(tier=tier):
                command = _declared(f"tests/client/{tier}")
                argv = self._dispatch(command, agent=AGENT)
                self.assertDispatchedVerb(argv, "regression", command)

    # ── not dispatchable, and declared as the client itself ──────────────

    def test_a_discovery_with_no_start_directory_is_not_dispatchable(self):
        for command in (f"{INTERPRETER} -m unittest discover -p {PATTERN} -t .",
                        f"{INTERPRETER} -m unittest discover"):
            with self.subTest(command=command):
                self.assertIsNone(
                    self._dispatch(command, agent=AGENT, release=RELEASE,
                                   cycle=CYCLE),
                    f"{command!r} declares no start directory, so the gate "
                    f"has nothing it can dispatch")

    def test_a_script_invoking_the_python_client_runs_as_declared(self):
        declared = ("python3 /opt/install/clients/python-crucible.py regression "
                    "--start-dir tests/client/unit --pattern test_*.py")
        argv = self._dispatch(declared, agent=AGENT, release=RELEASE,
                              cycle=CYCLE)
        self.assertEqual(
            argv,
            ["python3", "/opt/install/clients/python-crucible.py", "regression",
             "--start-dir", "tests/client/unit", "--pattern", "test_*.py",
             "--agent", AGENT, "--release", RELEASE, "--cycle", str(CYCLE)],
            "a declaration that already invokes the python client is its own "
            "invocation: its verb is never rewritten from its start directory")


if __name__ == "__main__":
    unittest.main()
