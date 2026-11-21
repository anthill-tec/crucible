"""The helpers of `test_every_cycle_help_line_describes_its_own_verb.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

from pathlib import Path


TIERS = ("unit", "module", "integration", "e2e", "bdd")

# The go client reads a tier off `go list` (the test files the tagged list
# names and the untagged one does not), and a `go list` that fails is a hard
# stop. The census's fake `go` answers `go list` but runs no tagged `go test`
# as asked, so a go tier drive gets this front end, inserted after the fake's
# shebang: `go list` answered as the
# real one answers it for a one-package module (its `_test.go` files, each kept
# or dropped by its `//go:build` line under `-tags`), and a tagged `go test`
# answered with the `go test -json` events of exactly the tests its `-run`
# names, every one passing (or, with `_GT_OUTCOME = "fail"`, the last one
# failing). Every other call falls through to the fake.
_GO_TIER_FRONT_END = r'''
import json as _gt_json, os as _gt_os, re as _gt_re, sys as _gt_sys


def _gt_module():
    try:
        with open("go.mod") as handle:
            for line in handle:
                if line.startswith("module "):
                    return line.split()[1]
    except OSError:
        pass
    return "example.com/probe"


def _gt_flag(argv, name):
    return argv[argv.index(name) + 1] if name in argv[:-1] else None


def _gt_test_files(tags):
    kept = []
    for name in sorted(_gt_os.listdir(".")):
        if not name.endswith("_test.go"):
            continue
        with open(name) as handle:
            first = handle.readline().strip()
        if first.startswith("//go:build "):
            expr = first[len("//go:build "):].strip()
            wanted = expr.lstrip("!")
            if (wanted in tags) == expr.startswith("!"):
                continue
        kept.append(name)
    return kept


_gt_argv = _gt_sys.argv[1:]
if _gt_argv[:1] == ["list"]:
    _gt_tags = (_gt_flag(_gt_argv, "-tags") or "").split(",")
    _gt_package = {"Dir": _gt_os.getcwd(), "ImportPath": _gt_module()}
    _gt_files = _gt_test_files([t for t in _gt_tags if t])
    if _gt_files:
        _gt_package["TestGoFiles"] = _gt_files
    _gt_sys.stdout.write(_gt_json.dumps(_gt_package, indent="\t") + "\n")
    _gt_sys.exit(0)
if _gt_argv[:1] == ["test"] and "-tags" in _gt_argv:
    _gt_pkg = _gt_module()
    _gt_run = _gt_re.fullmatch(r"\^\((.*)\)\$", _gt_flag(_gt_argv, "-run") or "")
    _gt_names = _gt_run.group(1).split("|") if _gt_run else []

    def _gt_emit(**event):
        _gt_sys.stdout.write(_gt_json.dumps({"Package": _gt_pkg, **event}) + "\n")

    _gt_failed = False
    _gt_emit(Action="start")
    for _gt_index, _gt_name in enumerate(_gt_names):
        _gt_fails = _GT_OUTCOME == "fail" and _gt_index == len(_gt_names) - 1
        _gt_failed = _gt_failed or _gt_fails
        _gt_word = "FAIL" if _gt_fails else "PASS"
        _gt_emit(Action="run", Test=_gt_name)
        _gt_emit(Action="output", Test=_gt_name, Output="=== RUN   " + _gt_name + "\n")
        if _gt_fails:
            _gt_emit(Action="output", Test=_gt_name,
                     Output="    probe_test.go:9: gate_fixture_known_failure\n")
        _gt_emit(Action="output", Test=_gt_name,
                 Output="--- " + _gt_word + ": " + _gt_name + " (0.00s)\n")
        _gt_emit(Action=_gt_word.lower(), Test=_gt_name, Elapsed=0)
    _gt_emit(Action="output", Output=("FAIL\n" if _gt_failed else "PASS\n"))
    _gt_emit(Action="output", Output=("FAIL" if _gt_failed else "ok  ")
             + "\t" + _gt_pkg + "\t0.001s\n")
    _gt_emit(Action="fail" if _gt_failed else "pass", Elapsed=0)
    _gt_sys.exit(1 if _gt_failed else 0)
'''


def _answer_go_tier_lists(bin_dir, outcome="pass"):
    """Put `_GO_TIER_FRONT_END` in front of the `go` in `bin_dir`, its
    tagged run passing every test (`pass`) or failing the last (`fail`)."""
    go = Path(bin_dir) / "go"
    shebang, rest = go.read_text().split("\n", 1)
    go.write_text(shebang + f"\n_GT_OUTCOME = {outcome!r}\n"
                  + _GO_TIER_FRONT_END + rest)
    go.chmod(0o755)
