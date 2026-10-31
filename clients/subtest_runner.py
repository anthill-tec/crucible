"""Fleet-shared unittest runner: every subtest counted, the run streamed.

``python-crucible.py`` runs this file by path, with the project's own
interpreter (optionally under ``coverage run``). It takes unittest's own
command line (``discover -s <dir> -p <pattern> -v``, or dotted targets plus
``-v``) and runs ``unittest`` through ``unittest.TextTestRunner`` with a
subclass of ``unittest.TextTestResult`` (CR-CRU-224 §S1). It writes no JUnit
report. An ``-o <dir>`` (the reports option of the command line before
CR-CRU-224) is accepted and dropped.

The counting rule is CR-CRU-189's:

* A passing subtest is its own case.
* A parent's own success is not recorded once any of its subtests was:
  the parent is counted as its subtests.
* A parent that fails or errors in its body or ``tearDown`` is still a case
  of its own, named as the parent.
* An enclosing subtest is counted like a parent: its own pass is dropped once
  a subtest nested inside it was recorded; its own failure is still a case.
* A test under ``@expectedFailure`` is counted as a whole.

The console prints one verbose verdict line per counted case, passing
subtests included.

When ``CRUCIBLE_STREAM`` names a file, the runner removes the variable from
its own environment before any test runs, opens the file in truncate mode and
writes the Crucible event stream to it (CR-CRU-200's shape), one
``json.dumps`` line per event, each written through as it is made: a
``run-start`` carrying ``countTestCases()``, one ``test-end`` per counted
case, and a ``run-end`` whose totals are the ``test-end`` counts. A stream
write that fails is said once on stderr; the stream then stops and the test
run finishes.

The exit code is unittest's own: 0 on success, 5 when no test ran, 1
otherwise. Stdlib only; needs Python 3.12 or later (``addDuration`` and
unittest's exit 5).
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import unittest
import unittest.case
import unittest.suite
from typing import Any, cast
from unittest.util import strclass

# unittest's own classes for a subtest and for a class- or module-level
# fixture's error holder: private, and absent from the type stubs.
_SubTest: Any = unittest.case._SubTest  # pyright: ignore[reportAttributeAccessIssue]
_ErrorHolder: Any = unittest.suite._ErrorHolder  # pyright: ignore[reportAttributeAccessIssue]

# The environment variable naming the stream file.
STREAM_VAR = "CRUCIBLE_STREAM"

# The reports-dir option of the command line before CR-CRU-224; accepted and
# dropped.
_REPORTS_OPTION = "-o"

# The suite prefix a test run as a script carries, stripped from `suite`.
_MAIN_PREFIX = "__main__."

# An error holder's description: `setUpClass (module.Class)`,
# `setUpModule (module)` and their teardown siblings.
_HOLDER_DESCRIPTION = re.compile(r"^\w+ \((?P<target>[^()]+)\)$")

# The failure an unexpected success carries: unittest raises nothing for it.
_UNEXPECTED_SUCCESS = {
    "type": "UnexpectedSuccess",
    "message": ("Unexpected success: This test was marked as expected failure "
                "but passed, please review it"),
}


def _restore_module_search_path() -> None:
    """Make ``sys.path[0]`` what ``python -m`` gives it: the working directory.

    Running a file by path puts the file's own directory first on
    ``sys.path``; ``-m`` puts the working directory there instead, which is
    what a dotted test target and a project-local import rely on. Under
    ``PYTHONSAFEPATH`` neither is added, so nothing is replaced."""
    own_dir = os.path.dirname(os.path.abspath(__file__))
    if sys.path and os.path.abspath(sys.path[0] or os.curdir) == own_dir:
        sys.path[0] = os.getcwd()


def _without_reports_option(args: list) -> list:
    """``args`` with any ``-o <dir>`` dropped."""
    kept: list = []
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg == _REPORTS_OPTION:
            skip = True
        else:
            kept.append(arg)
    return kept


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


def _suite_of(cls: type) -> str:
    """A case's ``module.Class``, a leading ``__main__.`` stripped."""
    name = strclass(cls)
    return name[len(_MAIN_PREFIX):] if name.startswith(_MAIN_PREFIX) else name


def _module_file(module_name: str) -> str | None:
    """The source file of a loaded module, or None."""
    module = sys.modules.get(module_name)
    return getattr(module, "__file__", None) if module is not None else None


def _holder_file(holder: Any) -> str | None:
    """The file of the class or module an error holder's description names."""
    found = _HOLDER_DESCRIPTION.match(holder.description)
    if found is None:
        return _module_file(type(holder).__module__)
    target = found.group("target")
    while target:
        path = _module_file(target)
        if path is not None:
            return path
        target = target.rpartition(".")[0]
    return _module_file(type(holder).__module__)


def _shown_path(path: str | None) -> str | None:
    """``path`` relative to the working directory when it lies under it,
    else absolute, with ``\\`` read as ``/``."""
    if path is None:
        return None
    absolute = os.path.abspath(path)
    cwd = os.getcwd()
    try:
        under = os.path.commonpath([absolute, cwd]) == cwd
        shown = os.path.relpath(absolute, cwd) if under else absolute
    except ValueError:
        shown = absolute
    return shown.replace("\\", "/")


class EventStream:
    """The stream file ``CRUCIBLE_STREAM`` names, written line by line.

    Opened in truncate mode and unbuffered, so each line is in the file once
    ``write`` returns. The first ``OSError`` -- opening or writing -- is said
    once on stderr, and nothing more is written."""

    def __init__(self, path: str | None) -> None:
        self._path = path
        self._file: Any = None
        if path is None:
            return
        try:
            self._file = open(path, "wb", buffering=0)  # noqa: SIM115 -- closed by close()
        except OSError as exc:
            self._give_up(exc)

    def _give_up(self, exc: OSError) -> None:
        print(f"[subtest-runner] {STREAM_VAR}: cannot write the stream to "
              f"{self._path}, so it stops here and the run goes on: "
              f"{' '.join(str(exc).split())}",
              file=sys.stderr, flush=True)
        self.close()

    def write(self, event: dict) -> None:
        """Write one event as one ``json.dumps`` line."""
        if self._file is None:
            return
        data = (json.dumps(event) + "\n").encode("ascii")
        try:
            while data:
                written = self._file.write(data)
                data = data[written:]
        except OSError as exc:
            self._give_up(exc)

    def close(self) -> None:
        """Close the file, if open."""
        handle, self._file = self._file, None
        if handle is not None:
            handle.close()


class StreamingTestResult(unittest.TextTestResult):
    """unittest's text result, counting every subtest and streaming each
    counted case as a ``test-end``."""

    events: EventStream = EventStream(None)
    total: int = 0

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._subtest_maps: list = []
        self._current: Any = None
        self._outcome: tuple | None = None
        self._duration: float | None = None
        self._test_started = 0.0
        self._case_mark = 0.0
        self._run_started = 0.0
        self._counts = {"total": 0, "passed": 0, "failed": 0, "pending": 0}

    # -- the run --------------------------------------------------------

    def startTestRun(self) -> None:  # noqa: N802 -- unittest's name
        super().startTestRun()
        self._run_started = time.perf_counter()
        self.events.write({"event": "run-start", "total": self.total})

    def stopTestRun(self) -> None:  # noqa: N802 -- unittest's name
        self.events.write({"event": "run-end", **self._counts,
                           "duration_ms": self._ms_since(self._run_started)})
        super().stopTestRun()

    # -- one test -------------------------------------------------------

    def startTest(self, test: Any) -> None:  # noqa: N802 -- unittest's name
        self._subtest_maps = []
        self._current = test
        self._outcome = None
        self._duration = None
        self._test_started = self._case_mark = time.perf_counter()
        super().startTest(test)

    def stopTest(self, test: Any) -> None:  # noqa: N802 -- unittest's name
        if test is self._current and self._outcome is not None:
            status, failure = self._outcome
            duration = (self._duration * 1000.0 if self._duration is not None
                        else self._ms_since(self._test_started))
            self._emit(test.id(), test._testMethodName, type(test),
                       _module_file(type(test).__module__), status, duration, failure)
        self._current = None
        super().stopTest(test)

    def addDuration(self, test: Any, elapsed: float) -> None:  # noqa: N802 -- unittest's name
        super().addDuration(test, elapsed)
        if test is self._current:
            self._duration = elapsed

    def addSuccess(self, test: Any) -> None:  # noqa: N802 -- unittest's name
        if self._subtest_maps:
            return
        super().addSuccess(test)
        self._settle(test, "pass", None)

    def addFailure(self, test: Any, err: Any) -> None:  # noqa: N802 -- unittest's name
        super().addFailure(test, err)
        self._failed(test, err)

    def addError(self, test: Any, err: Any) -> None:  # noqa: N802 -- unittest's name
        super().addError(test, err)
        self._failed(test, err)

    def addSkip(self, test: Any, reason: str) -> None:  # noqa: N802 -- unittest's name
        super().addSkip(test, reason)
        if isinstance(test, _SubTest):
            self._subtest_maps.append(_params_maps(test))
            self._emit_subtest(test, "pending", None)
        elif isinstance(test, _ErrorHolder):
            self._emit_holder(test, "pending", None)
        else:
            self._settle(test, "pending", None)

    def addExpectedFailure(self, test: Any, err: Any) -> None:  # noqa: N802 -- unittest's name
        super().addExpectedFailure(test, err)
        self._settle(test, "pending", None)

    def addUnexpectedSuccess(self, test: Any) -> None:  # noqa: N802 -- unittest's name
        super().addUnexpectedSuccess(test)
        self._settle(test, "fail", dict(_UNEXPECTED_SUCCESS))

    def addSubTest(self, test: Any, subtest: Any, err: Any) -> None:  # noqa: N802 -- unittest's name
        maps = _params_maps(subtest)
        if err is not None:
            self._subtest_maps.append(maps)
            super().addSubTest(test, subtest, err)
            self._emit_subtest(subtest, "fail", self._failure(err, test))
            return
        if _expecting_failure(test):
            return
        if any(_encloses(maps, seen) for seen in self._subtest_maps):
            return
        self._subtest_maps.append(maps)
        super().addSubTest(test, subtest, err)
        if self.showAll:
            # TextTestResult's own verdict writer, absent from the type stubs.
            self._write_status(subtest, "ok")  # pyright: ignore[reportAttributeAccessIssue]
        elif self.dots:
            self.stream.write(".")
            self.stream.flush()
        self._emit_subtest(subtest, "pass", None)

    # -- helpers --------------------------------------------------------

    def _failed(self, test: Any, err: Any) -> None:
        failure = self._failure(err, test)
        if isinstance(test, _ErrorHolder):
            self._emit_holder(test, "fail", failure)
        else:
            self._settle(test, "fail", failure)

    def _failure(self, err: Any, test: Any) -> dict:
        exc_type, exc_value = err[0], err[1]
        return {"message": str(exc_value), "type": exc_type.__name__,
                "trace": self._exc_info_to_string(err, test)}  # pyright: ignore[reportAttributeAccessIssue]

    def _settle(self, test: Any, status: str, failure: dict | None) -> None:
        """Record the running test's own outcome; the first failure stands."""
        if test is not self._current:
            return
        if self._outcome is None or (self._outcome[0] != "fail" and status == "fail"):
            self._outcome = (status, failure)

    def _emit_subtest(self, subtest: Any, status: str, failure: dict | None) -> None:
        case = subtest.test_case
        now = time.perf_counter()
        duration = max(0.0, (now - self._case_mark) * 1000.0)
        self._case_mark = now
        sub_id = subtest.id()
        name = case._testMethodName + sub_id[len(case.id()):]
        self._emit(sub_id, name, type(case),
                   _module_file(type(case).__module__), status, duration, failure)

    def _emit_holder(self, holder: Any, status: str, failure: dict | None) -> None:
        self._emit(holder.id(), holder.description, type(holder),
                   _holder_file(holder), status, 0.0, failure)

    def _emit(self, case_id: str, name: str, cls: type, path: str | None,
              status: str, duration_ms: float, failure: dict | None) -> None:
        event: dict = {"event": "test-end", "id": case_id, "name": name,
                       "suite": _suite_of(cls)}
        shown = _shown_path(path)
        if shown is not None:
            event["file"] = shown
        event["status"] = status
        event["duration_ms"] = max(0.0, duration_ms)
        if failure is not None:
            event["failure"] = failure
        self._counts["total"] += 1
        key = {"pass": "passed", "fail": "failed"}.get(status, "pending")
        self._counts[key] += 1
        self.events.write(event)

    @staticmethod
    def _ms_since(start: float) -> float:
        return max(0.0, (time.perf_counter() - start) * 1000.0)


def streaming_runner_class(events: EventStream) -> type:
    """A ``TextTestRunner`` building a ``StreamingTestResult`` that writes to
    ``events``, with the suite's ``countTestCases()`` as its total."""

    class StreamingTestRunner(unittest.TextTestRunner):
        """unittest's text runner, streaming the run."""

        resultclass = StreamingTestResult

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self._total = 0

        def run(self, test: Any) -> Any:
            self._total = test.countTestCases()
            return super().run(test)

        def _makeResult(self) -> Any:  # noqa: N802 -- unittest's name
            result = cast(StreamingTestResult, super()._makeResult())
            result.events = events
            result.total = self._total
            return result

    return StreamingTestRunner


def main() -> None:
    """Run the suite unittest's command line names, streaming it when
    ``CRUCIBLE_STREAM`` names a file."""
    _restore_module_search_path()
    path = os.environ.pop(STREAM_VAR, None) or None
    events = EventStream(path)
    try:
        unittest.main(module=None, argv=[sys.argv[0], *_without_reports_option(sys.argv[1:])],
                      testRunner=streaming_runner_class(events))
    finally:
        events.close()


if __name__ == "__main__":
    main()
