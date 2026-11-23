"""The calls a streamed rust run makes of cargo, answered the way real
cargo-nextest 0.9.130 and cargo-llvm-cov 0.8.4 answer them, for the fake
`cargo` programs the client tests put first on `PATH`.

A fake `cargo` imports this module and hands it the tests it would run, as
`case(...)` dicts. Two entry points split the work around the fake's own
prologue (its spawn stamp, its blocking marker, its grandchild):
  - `preliminary(argv, cases)` answers the calls made before the run step:
    `nextest --version`, `nextest list --message-format json`, `llvm-cov
    show-env`, `llvm-cov report` and `llvm-cov clean`;
  - `streamed_run(argv, cases, before_case)` answers a `nextest run` given
    `--message-format libtest-json-plus`: the stream on stdout, the human
    output on stderr, as nextest writes them (tests/fixtures/nextest/README.md).
Each returns the exit code to leave with, or None for a call it does not
answer (the fake's own behaviour for today's calls goes on unchanged).
`preliminary` records the calls it answers; a fake records every other call
itself (`record_call`), the run step included.

Knobs, all read from the environment:
  FAKE_NEXTEST_VERSION   the version `nextest --version` reports (0.9.130);
                         `unreadable` answers no version at all.
  FAKE_LIST_COMPILE_ERROR=1   the list fails to build: rustc errors on
                         stderr, empty stdout, exit 101.
  FAKE_NEXTEST_FIXTURE   a captured run directory (list.json, stream.jsonl):
                         its list and stream are answered byte for byte.
  FAKE_STREAM_SILENT=1   the run writes no stream line (FAKE_RUN_EXIT, 101).
  FAKE_STREAM_CUT_AFTER=k   the run stops dead after case k's `started` line
                         (FAKE_RUN_EXIT, 101).
  FAKE_HUMAN_TOTAL       the total nextest's human `Starting` line states.
  FAKE_RUN_EXIT          the run's exit code (default: 100 when a test
                         failed, 4 when no test ran, else 0).
  FAKE_LCOV              the lcov text `llvm-cov report` writes
                         (FAKE_LCOV_FILE: a file holding it, read instead).
  FAKE_CARGO_CALLS       a file each call appends one JSON line to: its argv,
                         cwd, the stream and coverage variables it saw, and
                         the `.profraw` files under the target directory.
  FAKE_NEXTEST_KINDS=1   the list and the run honour the call's selection
                         as cargo and nextest do: the cargo target flags
                         (`--lib`, `--bins`, `--tests`, `--test <name>`)
                         build only the binaries they name, and the
                         `kind(<k>)` predicates of `-E` expressions select
                         binaries by kind, and its `test(<name>)`
                         predicates select tests whose name holds `<name>`
                         (`=<name>`: is it). A binary outside the selection
                         is listed with no testcase and is not run; a test
                         its `test(...)` does not select is listed as a
                         mismatch (reason `expression`) and is not run. An
                         ignored test is a mismatch (reason `ignored`)
                         before any `test(...)` is read, unless the call
                         carries `--run-ignored all`: then only the
                         selection decides. Every other `-E` predicate
                         selects all, so `(kind(lib) | kind(bin)) &
                         (test(x))` selects the lib and bin tests named x.
                         Off by default: a fake whose cases name no kind on
                         purpose keeps today's answer.
"""

import glob
import json
import os
import re
import sys

MIN_NEXTEST = "0.9.130"
STREAM_FORMAT = "libtest-json-plus"
STREAM_VARIABLE = "NEXTEST_EXPERIMENTAL_LIBTEST_JSON"
DEFAULT_LCOV = "SF:src/lib.rs\nDA:1,1\nLF:1\nLH:1\nend_of_record\n"
RUSTC_ERROR = ("error[E0425]: cannot find value `undefined_value` in this scope\n"
               " --> src/lib.rs:3:5\n  |\n3 |     undefined_value\n  |     "
               "^^^^^^^^^^^^^^^ not found in this scope\n\nerror: could not "
               "compile `fake-crate` (lib test) due to 1 previous error\n")
HERE = os.path.dirname(os.path.abspath(__file__))
RECORDED_ENV = ("NEXTEST_EXPERIMENTAL_LIBTEST_JSON", "LLVM_PROFILE_FILE",
                "CARGO_LLVM_COV", "CARGO_LLVM_COV_TARGET_DIR", "CARGO_TARGET_DIR",
                "RUSTC_WRAPPER")


def case(name, status="ok", crate="fake-crate", binary="fake_crate", kind="lib",
         message=None):
    """One test a fake runs: `status` is `ok`, `failed` or `ignored`."""
    return {"name": name, "status": status, "crate": crate, "binary": binary,
            "kind": kind, "message": message}


def option(argv, flag):
    """The value after `flag` in `argv`, or None."""
    for i, arg in enumerate(argv):
        if arg == flag and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith(flag + "="):
            return arg.split("=", 1)[1]
    return None


def target_dir(argv):
    """The target directory a call builds into: `--target-dir`, else
    CARGO_TARGET_DIR, else `target` under the cwd."""
    return (option(argv, "--target-dir") or os.environ.get("CARGO_TARGET_DIR")
            or os.path.join(os.getcwd(), "target"))


def record_call(argv):
    calls = os.environ.get("FAKE_CARGO_CALLS")
    if not calls:
        return
    roots = {os.path.join(os.getcwd(), "target"), target_dir(argv)}
    profraw = sorted({path for root in roots
                      for path in glob.glob(os.path.join(root, "**", "*.profraw"),
                                            recursive=True)})
    entry = {"argv": list(argv), "cwd": os.getcwd(),
             "env": {key: os.environ.get(key) for key in RECORDED_ENV},
             "profraw": profraw}
    with open(calls, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def read_calls(path):
    """Every call a fake recorded in `path`, in order."""
    try:
        with open(path, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]
    except FileNotFoundError:
        return []


def _binary_id(entry):
    if entry["kind"] in ("lib", "proc-macro"):
        return entry["crate"]
    if entry["kind"] == "bin":
        return f"{entry['crate']}::bin/{entry['binary']}"
    return f"{entry['crate']}::{entry['binary']}"


def _stream_name(entry):
    return f"{entry['crate']}::{entry['binary']}${entry['name']}"


_KIND_PREDICATE = re.compile(r"kind\(\s*([A-Za-z-]+)\s*\)")
_TEST_PREDICATE = re.compile(r"(?<![\w-])test\(\s*([^()]*?)\s*\)")


def expression_kinds(argv):
    """The binary kinds the `-E` expressions of `argv` name in `kind(...)`
    predicates, or None when they name none (every kind is selected)."""
    kinds = set()
    for i, arg in enumerate(argv[:-1]):
        if arg in ("-E", "--filterset", "--filter-expr"):
            kinds.update(_KIND_PREDICATE.findall(argv[i + 1]))
    return kinds or None


def honours_kinds():
    return os.environ.get("FAKE_NEXTEST_KINDS") == "1"


def _target_selected(entry, argv):
    """Whether cargo's target flags in `argv` build `entry`'s binary: none
    builds every target; `--lib` the lib (a proc-macro crate's lib
    included), `--bins` the bins, `--tests` every target built in test mode
    (lib, bins and `tests/` targets), `--test <name>` that one target."""
    named = [argv[i + 1] for i, arg in enumerate(argv[:-1]) if arg == "--test"]
    flags = {arg for arg in argv if arg in ("--lib", "--bins", "--tests")}
    if not flags and not named:
        return True
    kind = entry["kind"]
    return (("--lib" in flags and kind in ("lib", "proc-macro"))
            or ("--bins" in flags and kind == "bin")
            or "--tests" in flags
            or (kind == "test" and entry["binary"] in named))


def kind_selected(entry, argv):
    """Whether `entry`'s binary is selected by `argv`'s cargo target flags
    and `-E` kind predicates (always, unless FAKE_NEXTEST_KINDS=1)."""
    if argv is None or not honours_kinds():
        return True
    if not _target_selected(entry, argv):
        return False
    kinds = expression_kinds(argv)
    return kinds is None or entry["kind"] in kinds


def _expression_names(argv):
    """The `test(...)` predicates of `argv`'s `-E` expressions, or None
    when they name none (every test is selected)."""
    names = []
    for i, arg in enumerate(argv[:-1]):
        if arg in ("-E", "--filterset", "--filter-expr"):
            names.extend(_TEST_PREDICATE.findall(argv[i + 1]))
    return names or None


def name_selected(entry, argv):
    """Whether `entry`'s name is selected by `argv`'s `-E` `test(...)`
    predicates (always, unless FAKE_NEXTEST_KINDS=1)."""
    if argv is None or not honours_kinds():
        return True
    names = _expression_names(argv)
    if names is None:
        return True
    return any(entry["name"] == name[1:] if name.startswith("=")
               else name.lstrip("~") in entry["name"] for name in names)


def selected(entry, argv):
    """Whether a run of `argv` runs `entry`: its binary and its name are
    both selected."""
    return kind_selected(entry, argv) and name_selected(entry, argv)


def _filter_match(entry, argv):
    """The `filter-match` nextest lists `entry` under, as real nextest
    0.9.130 orders it under FAKE_NEXTEST_KINDS=1: an ignored test is
    `ignored` before the expression is read, unless the list carries
    `--run-ignored all`."""
    ignored = entry["status"] == "ignored"
    if not honours_kinds():
        return {"status": "mismatch", "reason": "ignored"} if ignored else {"status": "matches"}
    if ignored and option(argv or [], "--run-ignored") != "all":
        return {"status": "mismatch", "reason": "ignored"}
    if not name_selected(entry, argv):
        return {"status": "mismatch", "reason": "expression"}
    return {"status": "matches"}


def list_text(cases, argv=None):
    """`cargo nextest list --message-format json` for `cases`: an ignored
    test is listed as a mismatch (reason `ignored`), every other test as a
    match. Under FAKE_NEXTEST_KINDS=1 the call's selection is honoured as
    the module docstring states: a binary it does not select is listed with
    no testcase, and `test-count` counts the testcases listed."""
    suites = {}
    listed = 0
    for entry in cases:
        binary_id = _binary_id(entry)
        suite = suites.setdefault(binary_id, {
            "package-name": entry["crate"], "binary-id": binary_id,
            "binary-name": entry["binary"],
            "package-id": f"path+file:///fake/{entry['crate']}#0.1.0",
            "kind": entry["kind"],
            "binary-path": f"/fake/target/debug/deps/{entry['binary']}-0",
            "build-platform": "target", "cwd": f"/fake/{entry['crate']}",
            "status": "listed", "testcases": {}})
        if not kind_selected(entry, argv):
            continue
        listed += 1
        suite["testcases"][entry["name"]] = {
            "kind": "test", "ignored": entry["status"] == "ignored",
            "filter-match": _filter_match(entry, argv)}
    return json.dumps({
        "rust-build-meta": {"target-directory": "/fake/target",
                            "base-output-directories": ["debug"],
                            "non-test-binaries": {}, "build-script-out-dirs": {},
                            "linked-paths": [], "platforms": {}, "target-platforms": []},
        "test-count": listed, "rust-suites": suites})


def _fixture(name):
    fixture = os.environ.get("FAKE_NEXTEST_FIXTURE")
    if not fixture:
        return None
    with open(os.path.join(fixture, name), encoding="utf-8") as handle:
        return handle.read()


def _version():
    found = os.environ.get("FAKE_NEXTEST_VERSION", MIN_NEXTEST)
    if found == "unreadable":
        sys.stderr.write("error: the nextest binary printed nothing it can read\n")
        return 101
    sys.stdout.write(f"cargo-nextest {found} (f0feb11a1 2026-03-09)\n"
                     f"release: {found}\ncommit-hash: f0feb11a16eab1a138b9d7a4\n"
                     f"commit-date: 2026-03-09\nhost: x86_64-unknown-linux-gnu\n")
    return 0


def _show_env(argv):
    target = target_dir(argv)
    prefix = "export " if ("--sh" in argv or "--export-prefix" in argv) else ""
    sys.stderr.write("info: cargo-llvm-cov currently setting cfg(coverage)\n")
    for key, value in (("LLVM_PROFILE_FILE", f"'{target}/fake-%p-%24m.profraw'"),
                       ("__CARGO_LLVM_COV_RUSTC_WRAPPER", "1"),
                       ("RUSTC_WRAPPER", "/fake/bin/cargo-llvm-cov"),
                       ("CARGO_LLVM_COV", "1"), ("CARGO_LLVM_COV_SHOW_ENV", "1"),
                       ("CARGO_LLVM_COV_TARGET_DIR", target),
                       ("CARGO_LLVM_COV_BUILD_DIR", target)):
        sys.stdout.write(f"{prefix}{key}={value}\n")
    return 0


def _report(argv):
    lcov_file = os.environ.get("FAKE_LCOV_FILE")
    if lcov_file:
        with open(lcov_file, encoding="utf-8") as handle:
            text = handle.read()
    else:
        text = os.environ.get("FAKE_LCOV", DEFAULT_LCOV)
    output = option(argv, "--output-path")
    if output:
        path = output if os.path.isabs(output) else os.path.join(os.getcwd(), output)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)
    return 0


def _clean(argv):
    for root in {os.path.join(os.getcwd(), "target"), target_dir(argv)}:
        for path in glob.glob(os.path.join(root, "**", "*.profraw"), recursive=True):
            os.remove(path)
    return 0


def preliminary(argv, cases):
    """Answer a call made before the run step, or None for any other."""
    head = list(argv[:2])
    if head in (["nextest", "--version"], ["nextest", "-V"]):
        record_call(argv)
        return _version()
    if head == ["nextest", "list"]:
        record_call(argv)
        if os.environ.get("FAKE_LIST_COMPILE_ERROR") == "1":
            sys.stderr.write("   Compiling fake-crate v0.1.0 (/fake)\n" + RUSTC_ERROR)
            return 101
        sys.stdout.write(_fixture("list.json") or list_text(cases, argv))
        return 0
    if head == ["llvm-cov", "show-env"]:
        record_call(argv)
        return _show_env(argv)
    if head == ["llvm-cov", "report"]:
        record_call(argv)
        return _report(argv)
    if head == ["llvm-cov", "clean"]:
        record_call(argv)
        return _clean(argv)
    return None


def is_streamed_run(argv):
    return list(argv[:2]) == ["nextest", "run"] and option(
        argv, "--message-format") == STREAM_FORMAT


def _line(stream, event):
    stream.write(json.dumps(event, separators=(",", ":")) + "\n")
    stream.flush()


def _human(text):
    sys.stderr.write(text + "\n")
    sys.stderr.flush()


def streamed_run(argv, cases, before_case=None, empty_exit=None, silent=False):
    """Answer a streamed `nextest run`, or None for any other call.
    `empty_exit` is the exit of a run with no case (nextest's own is 4);
    `silent` writes no stream line, as FAKE_STREAM_SILENT does."""
    if not is_streamed_run(argv):
        return None
    if os.environ.get(STREAM_VARIABLE) != "1":
        _human(f"error: libtest-json-plus output is experimental: set "
               f"{STREAM_VARIABLE}=1 to enable it")
        return 95
    profile = option(argv, "-P") or option(argv, "--profile") or "default"
    cases = [entry for entry in cases if selected(entry, argv)]
    fixture = _fixture("stream.jsonl")
    if fixture is not None:
        sys.stdout.write(fixture)
        sys.stdout.flush()
        failed = '"event":"failed"' in fixture
        return int(os.environ.get("FAKE_RUN_EXIT", "100" if failed else "0"))
    stated = int(os.environ.get("FAKE_HUMAN_TOTAL", len(cases)))
    _human(f"    Starting {stated} tests across 1 binary (run ID: deadbeef, "
           f"nextest profile: {profile})")
    if silent or os.environ.get("FAKE_STREAM_SILENT") == "1":
        _human("error: test binary fake_crate exited abnormally")
        return int(os.environ.get("FAKE_RUN_EXIT", "101"))
    if not cases:
        _human("error: no tests to run")
        return int(os.environ.get("FAKE_RUN_EXIT",
                                  "4" if empty_exit is None else empty_exit))
    cut_after = int(os.environ.get("FAKE_STREAM_CUT_AFTER", "0"))
    fail_fast = "--no-fail-fast" not in argv
    out = sys.stdout
    first = cases[0]
    suite = {"crate": first["crate"], "test_binary": first["binary"],
             "kind": first["kind"]}
    _line(out, {"type": "suite", "event": "started", "test_count": len(cases),
                "nextest": suite})
    counts = {"ok": 0, "failed": 0, "ignored": 0}
    for index, entry in enumerate(cases, start=1):
        if before_case is not None:
            before_case(index)
        name = _stream_name(entry)
        _line(out, {"type": "test", "event": "started", "name": name})
        if index == cut_after:
            os._exit(int(os.environ.get("FAKE_RUN_EXIT", "101")))
        status = entry["status"]
        result = {"type": "test", "event": status, "name": name}
        if status != "ignored":
            result["exec_time"] = 0.001
        if status == "failed":
            result["stdout"] = entry["message"] or f"thread panicked: {entry['name']} failed\n"
        _line(out, result)
        counts[status] += 1
        verdict = {"ok": "PASS", "failed": "FAIL", "ignored": "SKIP"}[status]
        _human(f"        {verdict} [   0.001s] {entry['crate']} {entry['name']}")
        if status == "failed" and fail_fast:
            _human("   Cancelling due to test failure")
            return int(os.environ.get("FAKE_RUN_EXIT", "100"))
    _line(out, {"type": "suite", "event": "failed" if counts["failed"] else "ok",
                "passed": counts["ok"], "failed": counts["failed"],
                "ignored": counts["ignored"], "measured": 0, "filtered_out": 0,
                "exec_time": 0.001 * len(cases), "nextest": suite})
    _human(f"------------\n     Summary [   0.010s] {counts['ok'] + counts['failed']} "
           f"tests run: {counts['ok']} passed, {counts['failed']} failed, "
           f"{counts['ignored']} skipped")
    default = "100" if counts["failed"] else "0"
    return int(os.environ.get("FAKE_RUN_EXIT", default))


def private_fake_prelude(cases="[]", streamed=True):
    """The lines a test's own fake `cargo` starts with to answer a streamed
    run's calls: `cases` is a python expression, evaluated in the fake, for
    the tests it runs (bound to `_nx_cases`). A call this module does not
    answer falls through to the fake's own body, unchanged. With `streamed`
    False only the calls before the run step are answered: the fake's body
    answers the streamed run itself (`streamed_run(_nx_args, _nx_cases)`)."""
    text = ("import sys as _nx_sys\n"
            f"_nx_sys.path.insert(0, {HERE!r})\n"
            "import fake_nextest\n"
            "_nx_args = _nx_sys.argv[1:]\n"
            f"_nx_cases = {cases}\n"
            "_nx_code = fake_nextest.preliminary(_nx_args, _nx_cases)\n"
            "if _nx_code is None:\n"
            "    fake_nextest.record_call(_nx_args)\n")
    if streamed:
        text += "    _nx_code = fake_nextest.streamed_run(_nx_args, _nx_cases)\n"
    return text + ("if _nx_code is not None:\n"
                   "    _nx_sys.exit(_nx_code)\n")


def held_results(text):
    """The results a held nextest stream holds, by event: `{"ok": n,
    "failed": n, "ignored": n}`."""
    counts = {"ok": 0, "failed": 0, "ignored": 0}
    for line in (text or "").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if (isinstance(event, dict) and event.get("type") == "test"
                and event.get("event") in counts):
            counts[event["event"]] += 1
    return counts
