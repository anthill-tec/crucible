"""Fleet-shared unittest runner: xmlrunner with every subtest counted.

``python-crucible.py`` runs this file by path, with the project's own
interpreter (optionally under ``coverage run``), in place of
``python -m xmlrunner``. It takes exactly xmlrunner's command line
(``discover -s <dir> -p <pattern> -o <reports> -v``, or dotted targets) and
runs ``unittest`` through xmlrunner's own program
(``xmlrunner.runner.XMLTestProgram``), test runner
(``xmlrunner.runner.XMLTestRunner``) and report writer, with a subclass of
xmlrunner's result class (``xmlrunner.result._XMLTestResult``) that records
passing subtests too.

xmlrunner's own ``addSubTest`` writes a ``<testcase>`` only for a failing
subtest, and a parent whose subtests all pass is written once as itself, so a
suite reports fewer cases when it passes than when it fails. The counting
result class makes the total independent of the outcome:

* A passing subtest is recorded as its own case, through the same info class
  entry (``infoclass(..., subTest=subtest)``) a failing subtest is, so one
  subtest has one name in every run.
* A parent's own success is not recorded once any of its subtests was:
  the parent is counted as its subtests.
* A parent that fails or errors in its body or ``tearDown`` is still a case
  of its own, named as the parent (unittest reports it through
  ``addFailure``/``addError``).
* An enclosing subtest is counted like a parent: its own pass is dropped once
  a subtest nested inside it was recorded; its own failure is still a case.
* A test under ``@expectedFailure`` is reported as a whole, as xmlrunner
  always did.

When the interpreter has no xmlrunner at all, this prints Python's own ``-m``
text (``<interpreter>: No module named xmlrunner``) and exits 1. When
xmlrunner imports but offers no result class to extend, the run goes ahead on
xmlrunner's own ``__main__`` entry point, exactly as ``python -m xmlrunner``.

Stdlib-only apart from xmlrunner itself, which is the interpreter's own.
"""
from __future__ import annotations

import importlib
import importlib.util
import os
import runpy
import sys
from typing import Any

_XMLRUNNER = "xmlrunner"


def _restore_module_search_path() -> None:
    """Make ``sys.path[0]`` what ``python -m`` gives it: the working directory.

    Running a file by path puts the file's own directory first on
    ``sys.path``; ``-m`` puts the working directory there instead, which is
    what a dotted test target and a project-local import rely on. Under
    ``PYTHONSAFEPATH`` neither is added, so nothing is replaced."""
    own_dir = os.path.dirname(os.path.abspath(__file__))
    if sys.path and os.path.abspath(sys.path[0] or os.curdir) == own_dir:
        sys.path[0] = os.getcwd()


def _params_maps(subtest: Any) -> tuple:
    """The chain of parameter dicts a subtest carries, innermost first.

    A nested ``subTest`` chains its own parameters onto its enclosing block's
    (``ChainMap.new_child``), so an enclosing block's maps are the trailing,
    identical objects of every subtest nested inside it."""
    maps = getattr(getattr(subtest, "params", None), "maps", None)
    return tuple(maps) if maps is not None else ()


def _encloses(outer: tuple, inner: tuple) -> bool:
    """Whether the subtest with ``outer`` maps encloses the one with ``inner``."""
    if not outer or len(inner) <= len(outer):
        return False
    tail = inner[len(inner) - len(outer):]
    return all(a is b for a, b in zip(tail, outer, strict=True))


def _expecting_failure(test: Any) -> bool:
    """Whether unittest runs ``test`` under ``@expectedFailure`` -- the same
    lookup ``unittest.TestCase.run`` makes."""
    method = getattr(test, getattr(test, "_testMethodName", ""), None)
    return bool(getattr(test, "__unittest_expecting_failure__", False)
                or getattr(method, "__unittest_expecting_failure__", False))


def counting_result_class(base: Any) -> Any:
    """Subclass xmlrunner's result class ``base`` so every subtest is a case."""

    class CountingXMLTestResult(base):
        """xmlrunner's result, recording passing subtests as cases."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self._subtest_maps: list = []

        def startTest(self, test: Any) -> None:  # noqa: N802 -- unittest's name
            self._subtest_maps = []
            super().startTest(test)

        def addSubTest(self, testcase: Any, test: Any, err: Any) -> None:  # noqa: N802 -- unittest's name
            maps = _params_maps(test)
            if err is not None:
                self._subtest_maps.append(maps)
                super().addSubTest(testcase, test, err)
                return
            if _expecting_failure(testcase):
                return
            if any(_encloses(maps, seen) for seen in self._subtest_maps):
                return
            self._subtest_maps.append(maps)
            self._save_output_data()
            info = self.infoclass(self, testcase, self.infoclass.SUCCESS, None,
                                  subTest=test)
            self._prepare_callback(info, self.successes, "ok", ".")

        def addSuccess(self, test: Any) -> None:  # noqa: N802 -- unittest's name
            if self._subtest_maps:
                return
            super().addSuccess(test)

    return CountingXMLTestResult


def _run_counting(runner_mod: Any, result_class: Any) -> None:
    """Run xmlrunner's own program with the counting result class."""

    class CountingXMLTestRunner(runner_mod.XMLTestRunner):
        """xmlrunner's test runner, building the counting result."""

        def __init__(self, **kwargs: Any) -> None:
            kwargs.setdefault("resultclass", result_class)
            super().__init__(**kwargs)

    runner_mod.XMLTestProgram(module=None, testRunner=CountingXMLTestRunner)


def _extendable() -> tuple | None:
    """xmlrunner's runner module and result class, or None when this
    xmlrunner offers no result class the counting runner can extend."""
    try:
        result_mod = importlib.import_module(f"{_XMLRUNNER}.result")
        runner_mod = importlib.import_module(f"{_XMLRUNNER}.runner")
    except ImportError:
        return None
    base = getattr(result_mod, "_XMLTestResult", None)
    if not isinstance(base, type):
        return None
    if not all(hasattr(runner_mod, name)
               for name in ("XMLTestProgram", "XMLTestRunner")):
        return None
    return runner_mod, base


def main() -> None:
    """Run the suite xmlrunner's command line names."""
    _restore_module_search_path()
    if importlib.util.find_spec(_XMLRUNNER) is None:
        sys.exit(f"{sys.executable}: No module named {_XMLRUNNER}")
    found = _extendable()
    if found is None:
        runpy.run_module(_XMLRUNNER, run_name="__main__", alter_sys=True)
        return
    runner_mod, base = found
    _run_counting(runner_mod, counting_result_class(base))


if __name__ == "__main__":
    main()
