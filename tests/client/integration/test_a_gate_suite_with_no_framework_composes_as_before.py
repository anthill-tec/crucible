"""A gate of a stack that declares no framework composes its suites as before.

The shared `GateSuite` carries a `framework` field. Only the bun client sets
it. The python, maven, rust and arduino gates leave it unset, so the shared
composition (`gate_regression`) treats their suites by the rules it had
before:
- an own-stack suite is `coveredBy` the whole-suite run, with that run's
  counts;
- a suite another stack owns is dispatched to that stack's client, and its
  row carries its own counts and `client`;
- an `e2e` suite is listed excluded, with the reason;
- `regression` is never a member.

The python surface enumerates nothing, so a python gate is still its one
whole-suite run alone.

Each test drives the shared module (`clients/_crucible_axi.py`) through
`declared_gate_suites` and `gate_regression`, called exactly as the four
clients call them today. A stub surface stands for each stack's declaration
(its real target template, a reader of a fixed declaration), and stubs stand
for the whole-suite run and the dispatch. The dispatched suite is a real child
process printing its run's envelope.

What fails today, and why: `GateSuite` has no `framework` field. The rows
asserted after that are the composition as it stands, kept as the proof that
an unset framework changes nothing. The python test is that pin alone: it
passes today, and it would fail if a python gate composed suites or skipped its
whole-suite run.

TIER: integration (the dispatched suite is a spawned process).
"""

import argparse
import contextlib
import io
import sys
import unittest

from tests.client.live_run_harness import load_client, load_toon

AXI = load_client("_crucible_axi.py")
TOON = load_toon()

GATE = "pre-merge-gate"
DISPATCHED = "it-python"
DISPATCHED_COMMAND = "python3 -m unittest discover -s tests/it"
DECLARED_TIERS = ("unit", "integration", "e2e", "regression")

WHOLE_COUNTS = {"passed": 4, "failed": 0, "pending": 0, "total": 4, "files": 2}
DISPATCHED_COUNTS = {"passed": 2, "failed": 0, "pending": 0, "total": 2}


def _envelope_text(verb, counts):
    lines = [f"    {key}: {value}" for key, value in counts.items()]
    return "\n".join(["axi:", f"  verb: {verb}", "  ok: true", "  run:", *lines,
                      "  warnings: []"]) + "\n"


# The dispatched suite: a child process printing its run's envelope.
DISPATCHED_PROGRAM = f"import sys; sys.stdout.write({_envelope_text('regression', DISPATCHED_COUNTS)!r})"


def _surface(template, enumerates=True):
    """A stub of one stack's declaration surface: its real target template,
    reading `DECLARED_TIERS`, and enumerating them plus one python-owned
    suite."""
    declared = {template.replace("<tier>", tier) for tier in DECLARED_TIERS}

    def read(_args, name):
        return name if name in declared else None

    def suites(args, surface):
        return (tuple(AXI.template_declared_suites(args, surface))
                + ((DISPATCHED, DISPATCHED_COMMAND),))

    return AXI.DeclaredTierSurface(target=template, names="a stub declaration",
                                   read=read, run=lambda *_a, **_k: 0,
                                   suites=suites if enumerates else None)


class _Calls:
    """What the composition asked of the client's stubs."""

    def __init__(self):
        self.whole_suite = 0
        self.whole_suite_alone = 0
        self.dispatched = []

    def run_whole_suite(self):
        self.whole_suite += 1
        sys.stdout.write(_envelope_text(GATE, WHOLE_COUNTS))
        return 0

    def run_whole_suite_alone(self):
        self.whole_suite_alone += 1
        sys.stdout.write(_envelope_text(GATE, WHOLE_COUNTS))
        return 0

    def dispatch(self, suite):
        self.dispatched.append(suite.target)
        return [sys.executable, "-c", DISPATCHED_PROGRAM], None


class AGateOfAStackWithNoFrameworkComposesAsBeforeTest(unittest.TestCase):

    def gate(self, surface, stack):
        """`gate_regression` called as the clients call it today: its exit,
        its stdout, and the stubs' calls."""
        calls = _Calls()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = AXI.gate_regression(
                argparse.Namespace(suites=None), surface=surface, stack=stack,
                verb=GATE, whole_suite=calls.run_whole_suite,
                dispatch=calls.dispatch, context={"projectKey": "stub-key"},
                crucible_url="http://127.0.0.1:1",
                whole_suite_alone=calls.run_whole_suite_alone)
        return code, out.getvalue(), calls

    def expected_rows(self, surface, stack):
        rows = []
        for tier in AXI.TIER_MEANINGS:
            if tier not in DECLARED_TIERS or tier == "regression":
                continue
            target = surface.target.replace("<tier>", tier)
            if tier in AXI.GATE_UNCOVERED_TIERS:
                rows.append({"suite": target, "stack": stack, "gated": False,
                             "excluded": AXI.GATE_UNCOVERED_TIERS[tier]})
            else:
                rows.append({"suite": target, "stack": stack, "gated": True,
                             "coveredBy": AXI.whole_suite_label(stack),
                             **WHOLE_COUNTS, "outcome": "pass"})
        rows.append({"suite": DISPATCHED, "stack": "python", "gated": True,
                     "client": "python-crucible.py", **DISPATCHED_COUNTS,
                     "outcome": "pass"})
        return rows

    def assert_composed_as_before(self, template, stack):
        surface = _surface(template)
        self.assertIn("framework", AXI.GateSuite._fields,
                      f"the shared GateSuite carries a `framework` field; "
                      f"fields={AXI.GateSuite._fields!r}")
        suites = AXI.declared_gate_suites(argparse.Namespace(suites=None), surface, stack)
        self.assertEqual([getattr(suite, "framework", "<no field>") for suite in suites],
                         [None] * len(suites),
                         f"a {stack} gate leaves every suite's framework unset; "
                         f"suites={suites!r}")
        code, out, calls = self.gate(surface, stack)
        decoded = TOON.decode(out)
        axi = decoded.get("axi") if isinstance(decoded, dict) else None
        envelope = axi if isinstance(axi, dict) else {}
        self.assertEqual(code, 0, out)
        self.assertEqual((calls.whole_suite, calls.whole_suite_alone), (1, 0),
                         "the whole suite runs once, as the composition's base")
        self.assertEqual(calls.dispatched, [DISPATCHED],
                         "only the python-owned suite is dispatched")
        self.assertEqual(envelope.get("suites"), self.expected_rows(surface, stack), out)
        self.assertEqual(envelope.get("run"),
                         {"passed": 6, "failed": 0, "pending": 0, "total": 6, "files": 2},
                         out)

    def test_a_maven_gates_suites_rows_are_as_before(self):
        """Maven (`<tier>` profiles): framework unset; rows unchanged."""
        self.assert_composed_as_before("<tier>", "mvn")

    def test_a_rust_gates_suites_rows_are_as_before(self):
        """Rust (`<tier>` nextest profiles): framework unset; rows unchanged."""
        self.assert_composed_as_before("<tier>", "rust")

    def test_an_arduino_gates_suites_rows_are_as_before(self):
        """Arduino (`junit-<tier>` make targets): framework unset; rows
        unchanged."""
        self.assert_composed_as_before("junit-<tier>", "arduino")

    def test_a_python_gate_is_still_its_one_whole_suite_run(self):
        """Python's surface enumerates nothing: the gate is its whole-suite
        run alone, nothing composed or dispatched."""
        surface = _surface("tests/<tier>", enumerates=False)
        self.assertEqual(
            AXI.declared_gate_suites(argparse.Namespace(suites=None), surface, "python"), ())
        code, out, calls = self.gate(surface, "python")
        self.assertEqual(code, 0, out)
        self.assertEqual((calls.whole_suite, calls.whole_suite_alone, calls.dispatched),
                         (0, 1, []))
        self.assertEqual(out, _envelope_text(GATE, WHOLE_COUNTS),
                         "the gate's stdout is that run's own envelope alone")


if __name__ == "__main__":
    unittest.main()
