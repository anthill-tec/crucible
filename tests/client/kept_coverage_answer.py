"""The coverage a board answers it kept for a run, file by file, and the
`coverage` block a run's envelope states from that answer.

A board that keeps a run's coverage file by file answers a green coverage
run's ingest with, in its `run` block, `coverage` (the whole run's `lines` and,
when it has any, `functions`, each `{total, covered, percent}`),
`coverageFileCount` (how many files the run has) and `coverageFiles` (its
least covered files, at most ten, each `{path, lines, functions?}`), and with
the run's id at the answer's top-level `event`.

The envelope's `coverage` block states that answer:

  * `lines`, then `functions` (absent when the run has no functions axis):
    each the axis's percent;
  * then, only when the answer carries the run's files, `event` (the answer's
    own), `fileCount` (the answer's own), `moreFiles` (the files the block
    does not list, never below 0) and `files`, one row per answered file in
    the answer's order. A row's keys, in order, are `ROW_KEYS`; `file` is the
    answer's `path`, whole, and every figure is the answer's own number. The
    three function keys are null for a file with no functions axis.

`LEAST_COVERED` is the one table both shapes are built from: `answered_files`
writes it as the board answers it, `listed_rows` as the block lists it. Its
order is the board's and deliberately follows no rule a client could re-derive
(neither by name nor by any percent), one figure is deliberately not what its
counts divide to and another carries three decimals, so a client that
re-sorts, recomputes or rounds again is caught. Two of its files have no
functions axis.

Not a test module: it holds no `TestCase`.
"""

#: A row's keys, in the order the block lists them.
ROW_KEYS = ("file", "linesPercent", "linesCovered", "linesTotal",
            "functionsPercent", "functionsCovered", "functionsTotal")
#: A row's three function keys: null for a file with no functions axis.
ROW_FUNCTION_KEYS = ROW_KEYS[4:]
#: The keys the block gains, in order, when the answer carries the run's files.
FILE_KEYS = ("event", "fileCount", "moreFiles", "files")

#: The run's id, as the board answers it at the answer's top level.
EVENT = "evt-kept-coverage-7f3a"
#: How many files the board says the run has: two more than it answers.
FILE_COUNT = 12

#: The coverage the board says it kept for the whole run.
KEPT_COVERAGE = {"lines": {"total": 480, "covered": 295, "percent": 61.46},
                 "functions": {"total": 64, "covered": 27, "percent": 42.19}}
#: The same, for a run with no functions axis.
KEPT_LINES_ONLY = {"lines": KEPT_COVERAGE["lines"]}

#: The ten files the board answers, in its order: `(path, lines covered, lines
#: total, lines percent, functions covered, functions total, functions
#: percent)`, the last three None for a file with no functions axis.
LEAST_COVERED = (
    ("/work/project/src/drivers/motor controller, v2.cpp", 0, 37, 0, 0, 4, 0),
    # 3 of 41 is not 7.5: the percent is the board's, never recomputed.
    ("src/ingest/decode.ts", 3, 41, 7.5, 1, 6, 16.667),
    ("src/types.ts", 1, 9, 11.11, None, None, None),
    ("app/reports/summary.py", 12, 80, 15, 2, 9, 22.22),
    ("src/store/queue.ts", 10, 40, 25, 0, 3, 0),
    ("src/zeta/last.ts", 4, 20, 20, 1, 2, 50),
    ("calc/calc.go", 9, 30, 30, 2, 5, 40),
    ("src/main/java/app/Service.java", 21, 60, 35, 3, 8, 37.5),
    ("src/alpha/first.ts", 18, 45, 40, 4, 4, 100),
    ("lib/plain_constants.py", 11, 22, 50, None, None, None),
)
#: The same ten with no functions axis on any of them.
LEAST_COVERED_LINES_ONLY = tuple(
    (path, covered, total, percent, None, None, None)
    for path, covered, total, percent, _fc, _ft, _fp in LEAST_COVERED)


def answered_files(figures=LEAST_COVERED):
    """`figures` as the board answers them in `run.coverageFiles`."""
    files = []
    for path, covered, total, percent, f_covered, f_total, f_percent in figures:
        kept = {"path": path,
                "lines": {"total": total, "covered": covered, "percent": percent}}
        if f_total is not None:
            kept["functions"] = {"total": f_total, "covered": f_covered,
                                 "percent": f_percent}
        files.append(kept)
    return files


def listed_rows(figures=LEAST_COVERED):
    """`figures` as the envelope's `coverage.files` lists them."""
    return [{"file": path, "linesPercent": percent, "linesCovered": covered,
             "linesTotal": total, "functionsPercent": f_percent,
             "functionsCovered": f_covered, "functionsTotal": f_total}
            for path, covered, total, percent, f_covered, f_total, f_percent
            in figures]


def filed_answer(coverage=KEPT_COVERAGE, event=EVENT, file_count=FILE_COUNT,
                 figures=LEAST_COVERED, passed=7):
    """A green coverage run's ingest answer from a board that kept the run's
    files: `{ok, changed, event, run}`, the `run` block carrying `coverage`,
    `coverageFileCount` and `coverageFiles`."""
    return {"ok": True, "changed": True, "event": event,
            "run": {"passed": passed, "failed": 0, "pending": 0, "total": passed,
                    "files": 3, "coverage": coverage,
                    "coverageFileCount": file_count,
                    "coverageFiles": answered_files(figures)}}


def stated_block(coverage=KEPT_COVERAGE, event=EVENT, file_count=FILE_COUNT,
                 figures=LEAST_COVERED):
    """The `coverage` block an envelope states from `filed_answer` of the same
    arguments, its keys in the block's order."""
    block = {axis: coverage[axis]["percent"] for axis in ("lines", "functions")
             if axis in coverage}
    block.update({"event": event, "fileCount": file_count,
                  "moreFiles": max(file_count - len(figures), 0),
                  "files": listed_rows(figures)})
    return block


def script_kept_files(board, coverage=KEPT_COVERAGE, **run):
    """Script a `RecordingBoard` to answer a green coverage run as
    `filed_answer` does: `run` is the `script_run` block (its counts), beside
    the kept `coverage`, the run's id and its ten of twelve files."""
    board.script_run(coverage=coverage, **run)
    board.script_coverage_files(EVENT, FILE_COUNT, answered_files())
