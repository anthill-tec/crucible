"""Shared fixtures for the go client's test-run tests.

The go client (`clients/go-crucible.py`) runs the toolchain's own
`go test -json`, so these fixtures drive the REAL `go` on PATH through a
recording shim first on `PATH`: every call is written (argv and working
directory) to a calls file and handed to the real `go` unchanged. Three
switches bend the shim, each named for what a test needs:

  - `GO_SHIM_VERSION=go1.23.4` answers `go version` and `go env GOVERSION`
    with that version (the floor tests);
  - `GO_SHIM_FAKE_ONLY=1` hands nothing to the real `go`: every other call
    exits 0 having printed nothing (a refusal that must run nothing);
  - `GO_SHIM_UNREADABLE_LIST=1` answers a `go test -list` call with text that
    is not `go test -json` and exits 2 (a list that cannot be read).

The Go modules live under `tests/fixtures/go-client`; each test copies the one
it needs to a scratch directory, so nothing builds in the repository's tree.

Not a test module: it holds no `TestCase`.
"""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    REPO_ROOT,
    RecordingBoard,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
GO_CLIENT = CLIENTS / "go-crucible.py"
PYTHON_CLIENT = CLIENTS / "python-crucible.py"
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "go-client"
AGENT = "go-runner"
PROJECT_KEY = "pk-go-run"
RUN_ID = "run-live-1"
START = "/api/v2/runs/start"
RUNS = "/api/v2/runs"
TIMEOUT = 180
GO_FLOOR = (1, 24)
STREAM_CODEC = "go-test"

# The fixture module's design, read off its test files by the spec's rules:
# the listed `Test*`/`Fuzz*`/`Example*` names (BenchmarkHello is not counted,
# ExampleNoOutput has no `// Output:` and is not listed), and the cases its
# run stores — passed, failed and pending — once each parent with recorded
# subtests is dropped or kept.
MODULE_LISTED = 11
MODULE_SPLIT = {"pass": 10, "fail": 5, "pending": 2}
# The packages of the fixture module that hold tests.
CASES_PKG = "example.com/gomod/cases"
PLAIN_PKG = "example.com/gomod/plain"

# Every environment variable that would steer the client or the toolchain
# away from what a test states.
_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_URL",
             "GO_CRUCIBLE_MODULE_DIR", "GO_CRUCIBLE_PROJECT_DIR", "GOFLAGS",
             "GOWORK", "GOTOOLCHAIN", "GO_SHIM_VERSION", "GO_SHIM_FAKE_ONLY",
             "GO_SHIM_UNREADABLE_LIST")

_GO_SHIM = r'''
import json, os, sys
argv = sys.argv[1:]
calls = os.environ.get("GO_SHIM_CALLS")
if calls:
    with open(calls, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"argv": argv, "cwd": os.getcwd()}) + "\n")
version = os.environ.get("GO_SHIM_VERSION")
if version and argv[:1] == ["version"]:
    print("go version %s linux/amd64" % version)
    sys.exit(0)
if version and argv[:1] == ["env"] and "GOVERSION" in argv:
    print(json.dumps({"GOVERSION": version}) if "-json" in argv else version)
    sys.exit(0)
if os.environ.get("GO_SHIM_FAKE_ONLY"):
    sys.exit(0)
if (os.environ.get("GO_SHIM_UNREADABLE_LIST") and "test" in argv
        and any(a == "-list" or a.startswith("-list=") for a in argv)):
    print("the list could not be read")
    sys.exit(2)
real = os.environ["GO_SHIM_REAL"]
os.execv(real, [real] + argv)
'''


def _version_tuple(text):
    found = re.search(r"go(\d+)\.(\d+)", text or "")
    return (int(found.group(1)), int(found.group(2))) if found else None


def go_toolchain_gap(need_bun=False):
    """What is missing to run these tests, or None. A missing toolchain FAILS
    a test, naming what is missing; it never skips one."""
    missing = []
    if need_bun and shutil.which("bun") is None:
        missing.append("bun (the real board is `bun run src/server.ts`)")
    go = shutil.which("go")
    if go is None:
        return "; ".join(missing + ["go 1.24 or later on PATH"])
    ran = subprocess.run([go, "version"], capture_output=True, text=True,
                         check=False, timeout=30)
    version = _version_tuple(ran.stdout)
    if version is None or version < GO_FLOOR:
        missing.append(f"go 1.24 or later (found: {ran.stdout.strip()[:80] or 'none'})")
    return "; ".join(missing) or None


def toolchain_env(**extra):
    """The environment a real `go` runs in for these tests: the local
    toolchain only, no workspace file, no inherited flags."""
    env = scrubbed_env()
    for key in _SCRUBBED:
        env.pop(key, None)
    env.update({"GOTOOLCHAIN": "local", "GOWORK": "off", "GOFLAGS": ""})
    env.update({k: str(v) for k, v in extra.items()})
    return env


def copy_fixture(name, dest):
    """Copy the fixture `name` into `dest` (created), and answer `dest`."""
    shutil.copytree(FIXTURES / name, dest, dirs_exist_ok=True)
    return str(dest)


#: What `go` prints for the directive `make_go_mod_unreadable` appends, read
#: by every `go list` and `go test` in that module.
UNREADABLE_GO_MOD_ERROR = "unknown directive: bogus"


def make_go_mod_unreadable(module_dir):
    """Append a directive `go` does not know to `module_dir`'s `go.mod`, so
    every `go list` and `go test` in that module fails reading it."""
    with open(os.path.join(module_dir, "go.mod"), "a", encoding="utf-8") as fh:
        fh.write("\nbogus directive\n")


def write_go_shim(bin_dir):
    shim = Path(bin_dir, "go")
    shim.write_text("#!" + sys.executable + "\n" + _GO_SHIM, encoding="utf-8")
    os.chmod(shim, stat.S_IRWXU)
    return str(shim)


def envelope(stdout):
    """The `axi` block of the client's one TOON envelope, or None."""
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout[-1500:]!r} "
            f"stderr={result.stderr[-1500:]!r}")


def warning_texts(axi):
    """Each warning of an envelope, as one string (code and detail)."""
    warnings = (axi or {}).get("warnings") or []
    return [json.dumps(w) if not isinstance(w, str) else w for w in warnings]


def said(axi):
    """Everything an envelope says in words: its error, help and warnings."""
    axi = axi or {}
    help_steps = axi.get("help") or []
    if isinstance(help_steps, str):
        help_steps = [help_steps]
    return " ".join([str(axi.get("error") or "")]
                    + [str(step) for step in help_steps] + warning_texts(axi))


def flag_value(argv, flag):
    """The value `argv` gives `flag`, as `-flag value` or `-flag=value`;
    None when absent."""
    for i, arg in enumerate(argv):
        if arg == flag and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith(flag + "="):
            return arg[len(flag) + 1:]
    return None


def go_events(text):
    """Each `go test -json` event of a stream, in order (a line that is not
    JSON is left out)."""
    events = []
    for line in (text or "").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def terminal_events(text):
    """`(Package, Test, Action)` for each terminal `pass`/`fail`/`skip` event
    carrying a `Test`."""
    return [(e.get("Package"), e["Test"], e["Action"]) for e in go_events(text)
            if e.get("Action") in ("pass", "fail", "skip") and e.get("Test")]


_STATUS = {"pass": "pass", "fail": "fail", "skip": "pending"}
_ERROR_LINE = re.compile(r"^\s+\S+\.go:\d+: ")


def expected_cases(text):
    """The cases a `go test -json` stream stores, as sorted `(suite, name,
    status)`: each terminal event carrying a `Test`, less the parents the
    subtest rule drops — a parent's `pass` once any subtest was recorded; a
    parent's `fail` when it printed no `error` output of its own and one of
    its recorded subtests failed. Own `error` output is read by `OutputType`
    where the toolchain writes it, else by the indented `file.go:LINE:`
    form."""
    events = go_events(text)
    typed = any("OutputType" in e for e in events)
    own_error = set()
    for e in events:
        if e.get("Action") != "output" or not e.get("Test"):
            continue
        if (e.get("OutputType") == "error" if typed
                else _ERROR_LINE.match(e.get("Output") or "")):
            own_error.add((e.get("Package"), e["Test"]))
    terminals = terminal_events(text)
    cases = []
    for pkg, test, action in terminals:
        children = [a for p, t, a in terminals if p == pkg
                    and t.startswith(test + "/") and "/" not in t[len(test) + 1:]]
        if children and action == "pass":
            continue
        if (children and action == "fail" and (pkg, test) not in own_error
                and "fail" in children):
            continue
        cases.append((pkg, test, _STATUS[action]))
    return sorted(cases)


def stored_cases(event):
    """The stored run's cases, as sorted `(suite, name, status)`."""
    return sorted((suite.get("name"), leaf.get("name"), leaf.get("status"))
                  for suite in event.get("tree") or []
                  for leaf in suite.get("children") or [])


def split(cases):
    """`{pass, fail, pending}` counts of `(suite, name, status)` rows."""
    counts = {"pass": 0, "fail": 0, "pending": 0}
    for _suite, _name, status in cases:
        counts[status] += 1
    return counts


def run_go_json(module_dir, *args):
    """A real `go test -json ./...` (with `args`) in `module_dir`: the oracle
    a client run is compared with. Answers its stdout."""
    go = shutil.which("go")
    if go is None:
        raise AssertionError("go is not on PATH")
    ran = subprocess.run([go, "test", "-json", *args, "./..."], cwd=module_dir,
                         env=toolchain_env(), capture_output=True, text=True,
                         check=False, timeout=TIMEOUT)
    return ran.stdout


class GoProject:
    """One scratch project on its own `RecordingBoard`, the recording `go`
    shim first on `PATH`. `fixture` is copied into the project dir (None:
    an empty project)."""

    def __init__(self, test, fixture: str | None = "module", project_dir=None):
        self.test = test
        self.board = RecordingBoard()
        test.addCleanup(self.board.close)
        self.dir = project_dir or new_scratch("go-project-")
        os.makedirs(self.dir, exist_ok=True)
        if fixture is not None:
            copy_fixture(fixture, self.dir)
        install_project(self.dir, self.board.url, PROJECT_KEY)
        outside = new_scratch("go-shim-")
        self.bin_dir = os.path.join(outside, "bin")
        os.makedirs(self.bin_dir)
        write_go_shim(self.bin_dir)
        self.calls_path = os.path.join(outside, "go-calls.jsonl")

    def declare_module_dir(self, value):
        """Add `[go] module_dir = "<value>"` to the project's crucible.toml."""
        with open(os.path.join(self.dir, "crucible.toml"), "a", encoding="utf-8") as fh:
            fh.write(f'\n[go]\nmodule_dir = "{value}"\n')

    def env(self, **extra):
        real = shutil.which("go") or "/nonexistent/go"
        env = toolchain_env(GO_SHIM_REAL=real, GO_SHIM_CALLS=self.calls_path)
        env["PATH"] = self.bin_dir + os.pathsep + env.get("PATH", "")
        env.update({k: str(v) for k, v in extra.items()})
        return env

    def drive(self, *argv, cwd=None, agent=AGENT, timeout=TIMEOUT, verb="test",
              client=None, **extra):
        """Run the client's `verb` (default `test`) with `argv`. `client` is
        the go client to spawn: the checkout's unless a test hands it a copy
        laid out in an install of its own."""
        cmd = [sys.executable, str(client or GO_CLIENT), verb, *argv]
        if agent:
            cmd += ["--agent", agent]
        cmd += ["--project-dir", self.dir]
        return subprocess.run(cmd, cwd=cwd or self.dir, env=self.env(**extra),
                              capture_output=True, text=True, timeout=timeout,
                              check=False)

    # ── what go was asked ──────────────────────────────────────────────────
    def calls(self):
        if not os.path.exists(self.calls_path):
            return []
        return [json.loads(line) for line in
                Path(self.calls_path).read_text(encoding="utf-8").splitlines()
                if line.strip()]

    def test_calls(self):
        """Every `go test` call, in order."""
        return [c for c in self.calls() if "test" in c["argv"]]

    def subcommand_calls(self, subcommand):
        """Every call whose go subcommand (its first argument) is
        `subcommand` — `build`, `test` — in order."""
        return [c for c in self.calls() if c["argv"][:1] == [subcommand]]

    def list_calls(self):
        return [c for c in self.test_calls() if flag_value(c["argv"], "-list") is not None]

    def run_calls(self):
        return [c for c in self.test_calls() if flag_value(c["argv"], "-list") is None]

    # ── what the board was sent ────────────────────────────────────────────
    def posts(self):
        return self.board.posts()

    def starts(self):
        return [b for p, b in self.posts() if p == START]

    def closes(self):
        return [b for p, b in self.posts() if p == RUNS]

    def run_route_posts(self):
        return [p for p, _b in self.posts() if p.startswith("/api/v2/runs")]

    def held(self):
        return self.board.held_stream(RUN_ID)

    def packages_run(self):
        """The packages whose tests reached the board's held stream."""
        return {pkg for pkg, _test, _action in terminal_events(self.held())}
