"""The gate marks its lone whole-suite run, and only while that run is made.

When a project declares no suite, `gate_regression` (`clients/_crucible_axi.py`)
makes one call, the stack's whole-suite run, and that run's envelope is the
gate's answer. The core marks that call in a module global beside
`_gate_suite_results`, `_lone_gate_stack`, which names the gate's stack while
the call runs and is None otherwise; the shared filed-run emitter reads it to
give the gate its verdict. So the mark:

  * names the stack, and only during the lone call (the alone call when the
    client gives one, else its whole-suite call);
  * is None again once that call returns, raises, or raises `SystemExit`;
  * is never set on the composed path, whose whole-suite run is one suite of
    several and is not the gate's answer;
  * is cleared by `forget_ingested_run`, with the rest of an invocation's
    run state.

Driven in process against the core alone: stub calls, a stub surface and a
stubbed suite declaration. No process, no socket, no wait.
"""

import importlib.util
import types
import unittest
from unittest import mock

from tests.client import client_script

AXI_MODULE_PATH = client_script("_crucible_axi.py")
MARK = "_lone_gate_stack"
#: What a read of the mark gives when the core has no such global.
NO_MARK = "<the core holds no _lone_gate_stack global>"


def _load_core():
    spec = importlib.util.spec_from_file_location(
        "axi_under_test_for_the_lone_gate_mark", AXI_MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_AXI = _load_core()


def _mark():
    return getattr(_AXI, MARK, NO_MARK)


def _lone_surface():
    """A surface that enumerates no declaration: the gate's call is lone."""
    return types.SimpleNamespace(suites=None)


class _MarkCase(unittest.TestCase):
    """Restores the core's mark as each test found it."""

    def setUp(self):
        had = hasattr(_AXI, MARK)
        before = getattr(_AXI, MARK, None)

        def restore():
            if had:
                setattr(_AXI, MARK, before)
            elif hasattr(_AXI, MARK):
                delattr(_AXI, MARK)

        self.addCleanup(restore)
        self.seen = []

    def gate(self, stack, *, whole_suite, whole_suite_alone=None, surface=None):
        return _AXI.gate_regression(
            types.SimpleNamespace(), surface=surface or _lone_surface(), stack=stack,
            verb="pre-merge-gate", whole_suite=whole_suite,
            whole_suite_alone=whole_suite_alone, dispatch=None, context={},
            crucible_url=lambda: "http://127.0.0.1:1")

    def recording(self, name, result=0, raises=None):
        """A run call that records the mark it saw, then returns `result` or
        raises `raises`."""
        def call():
            self.seen.append((name, _mark()))
            if raises is not None:
                raise raises
            return result
        return call


class TheLoneCallIsMarkedWithItsStackTest(_MarkCase):

    def test_the_mark_names_the_stack_during_the_alone_call_and_is_unset_after_it_returns(self):
        self.assertIsNone(_mark(), "no gate is running, so nothing is marked")
        code = self.gate("rust", whole_suite=self.recording("whole", 9),
                         whole_suite_alone=self.recording("alone", 3))
        self.assertEqual(code, 3, "the gate answers the lone call's exit")
        self.assertEqual(self.seen, [("alone", "rust")],
                         "only the alone call ran, and it saw the gate's stack marked")
        self.assertIsNone(_mark(), "the mark is unset once the call returned")

    def test_a_gate_with_no_alone_call_marks_its_whole_suite_call(self):
        code = self.gate("python", whole_suite=self.recording("whole", 1))
        self.assertEqual(code, 1)
        self.assertEqual(self.seen, [("whole", "python")],
                         "with no alone call, the whole-suite call is the lone one")
        self.assertIsNone(_mark())

    def test_the_mark_is_unset_after_the_lone_call_raises(self):
        with self.assertRaises(RuntimeError) as raised:
            self.gate("go", whole_suite=self.recording("whole"),
                      whole_suite_alone=self.recording(
                          "alone", raises=RuntimeError("the run escaped")))
        self.assertEqual(str(raised.exception), "the run escaped",
                         "the error is the call's own, propagated")
        self.assertEqual(self.seen, [("alone", "go")])
        self.assertIsNone(_mark(), "the mark is unset after the call raised")

    def test_the_mark_is_unset_after_the_lone_call_raises_system_exit(self):
        with self.assertRaises(SystemExit) as raised:
            self.gate("arduino", whole_suite=self.recording("whole"),
                      whole_suite_alone=self.recording("alone", raises=SystemExit(2)))
        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(self.seen, [("alone", "arduino")])
        self.assertIsNone(_mark(), "the mark is unset after the call exited")


class TheComposedPathIsNeverMarkedTest(_MarkCase):

    def test_a_gate_that_composes_declared_suites_never_sets_the_mark(self):
        suite = _AXI.GateSuite(target="unit", tier="unit", command=None, stack="mvn",
                               gated=True, excluded=None, framework=None)
        whole_suite = self.recording("whole", 0)

        def composition(suites, **kwargs):
            self.seen.append(("composition", _mark()))
            self.assertEqual(suites, (suite,))
            self.assertEqual(kwargs.get("stack"), "mvn")
            return kwargs["whole_suite"]()

        with mock.patch.object(_AXI, "declared_gate_suites",
                               return_value=(suite,)) as declared, \
                mock.patch.object(_AXI, "run_gate_suites", side_effect=composition):
            code = self.gate("mvn", whole_suite=whole_suite,
                             whole_suite_alone=self.recording("alone", 5))
        self.assertEqual(code, 0, "the gate answers its composition")
        self.assertEqual(declared.call_count, 1)
        self.assertEqual(self.seen, [("composition", None), ("whole", None)],
                         "the composition and its whole-suite run see no mark, and "
                         "the alone call never runs")
        self.assertIsNone(_mark())


class ForgettingAnInvocationsRunsClearsTheMarkTest(_MarkCase):

    def test_forget_ingested_run_clears_the_mark(self):
        setattr(_AXI, MARK, "bun")
        _AXI.forget_ingested_run()
        self.assertIsNone(_mark(), "an invocation's run state starts with no gate marked")


if __name__ == "__main__":
    unittest.main()
