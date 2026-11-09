#!/usr/bin/env python3
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Go Crucible CLI — single entry point for orchestrator + go-{red,green,fix,
verify} agent lifecycle ops AND for running a Go module's tests through the
toolchain's own `go test -json`, the run streamed to the board.

This script is tool-specific (the Go toolchain), not project-specific — the
project path is parameterizable.

Subcommands:
  register, unregister  Agent lifecycle.
  test                  go test -json ./... in the run's module, streamed to
                        the board, which decodes it with its `go-test` codec.
                        [--run REGEX] passes Go's own -run; a regex the
                        list finds no test for is refused before any run
                        opens.
  check                 go build ./... in the same module ([--tests]: the
                        test compile, no test and no vet check run); with
                        --agent a failing compile is filed, format `go`.
  plan / cycle / status verbs, the roadmap verbs and `next`: the fleet's
                        shared implementations, one thin delegator each.

The run's total:
  Before the run the client lists the run's tests (`go test -list <re> -json
  ./...`, `<re>` the top-level element of --run, `.` without it) and counts the
  `Test*`, `Fuzz*` and `Example*` names it prints; that count rides the run
  start as its `total`, so a listed test that never reports leaves the run
  incomplete. A list that cannot be read starts the run with no total.

The module dir, relative to the project dir, in this order:
  --module-dir > $GO_CRUCIBLE_MODULE_DIR > the nearest go.mod at or above the
  working directory (never above the project dir) > crucible.toml
  `[go] module_dir`. A named dir with no go.mod, or no module at all, is
  refused before anything runs.

The Go floor: go 1.24, the first whose `go test -json` writes build output
as events. An older toolchain is refused before anything runs.

Project + Crucible endpoint:
  Reads CRUCIBLE_PROJECT_KEY from <project-dir>/.env.
  Project path resolution: --project-dir > $GO_CRUCIBLE_PROJECT_DIR > the git
  repo containing the current directory > the current directory.
  Posts to the board the project's `crucible.toml` declares (`[client] url`),
  v2 endpoints ONLY: /api/v2/agents/register|unregister, /api/v2/runs/start,
  the run's /stream (codec go-test) and /api/v2/runs (the stream's close).
  The client parses no test result; the board decodes go's own stream.

Examples:
  go-crucible.py register --agent <agentId> --role RED --cycle <cycleId>
  go-crucible.py test --agent <agentId>
  go-crucible.py test --agent <agentId> --run 'TestParse/empty'
  go-crucible.py test --agent <agentId> --module-dir services/api
"""

# pi-lens-ignore: I001 — pi-lens lints with its own ruff configuration, which sets no target version, so ruff files `tomllib` as third-party whatever the declared floor
import argparse  # noqa: I001
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib

# The STACK this client's runs belong to — the name its sibling clients address
# it by (`go-crucible.py`).
_STACK = "go"
# The board codec that decodes `go test -json`, the stream this client relays
# and the framework the stored run names.
GO_TEST_CODEC = "go-test"
# The first Go whose `go test -json` writes `build-output` / `build-fail`.
GO_FLOOR = (1, 24)
GO_FLOOR_TEXT = "1.24"
# The file, in the run's own reports dir, the run's stream is written to.
_STREAM_FILE = "go-test.jsonl"
# How long the relay may take to land what is left of the stream at the end
# of a run, and of one a signal interrupted.
_STREAM_FINISH_SECONDS = 30
_INTERRUPTED_FINISH_SECONDS = 5
# The ways a project declares its module, named by every refusal of a module
# that cannot be found.
_MODULE_DECLARATION_HELP = (
    "declare the module with --module-dir <dir>, GO_CRUCIBLE_MODULE_DIR=<dir> "
    "or crucible.toml [go] module_dir = \"<dir>\" (each relative to the "
    "project dir), or run from inside the module")
# The dirs a gate never looks in for a module (hidden dirs are skipped too):
# vendored and test-fixture modules are not the project's own suite.
_SKIPPED_MODULE_DIRS = ("vendor", "testdata", "node_modules")
# The board codec that decodes a `go test -coverprofile` profile, the codec a
# `--coverage` run's close sends each module's profile under.
GO_COVERAGE_CODEC = "go-coverprofile"
# The runner a gate over several modules starts: each module's
# `go test -json ./...` in turn, its stdout the one run's stream. Its one
# argument is a JSON list of `[module, [extra go test flags]]`. A failing
# module does not stop the next; the exit is the worst any module gave (a
# module a signal ended counts as 128 + the signal).
_EACH_MODULE_RUNNER = r"""
import json, subprocess, sys
worst = 0
for module, extra in json.loads(sys.argv[1]):
    print(f"[crucible] running: go test -json ./... (in {module})",
          file=sys.stderr, flush=True)
    code = subprocess.run(["go", "test", "-json", *extra, "./..."], cwd=module,
                          check=False).returncode
    worst = max(worst, code if code >= 0 else 128 - code)
sys.exit(worst)
"""


def _resolve_project_dir(arg_value):
    """Resolution order: --project-dir > $GO_CRUCIBLE_PROJECT_DIR > git repo of
    CWD > CWD.

    No project is hardcoded. The `.env` holding CRUCIBLE_PROJECT_KEY must live
    at the resolved root. The root is BOUND into the shared module here, on
    the client's own boot path, so the project's `crucible.toml` beside that
    `.env` is the one its limits and board are read from."""
    if arg_value:
        root = arg_value
    elif (env_value := os.environ.get("GO_CRUCIBLE_PROJECT_DIR")):
        root = env_value
    else:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True, check=False)
        root = (r.stdout.strip() if r.returncode == 0 and r.stdout.strip()
                else os.getcwd())
    root = os.path.abspath(root)
    _axi().bind_project_dir(root)
    return root


def _read_env(project_dir):
    """Parse <project-dir>/.env into a dict (ignores blanks/comments). Empty if absent."""
    env = {}
    path = os.path.join(project_dir, ".env")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    return env


def _project_key(project_dir):
    key = _read_env(project_dir).get("CRUCIBLE_PROJECT_KEY", "").strip()
    if not key:  # an empty or whitespace-only key is a missing one
        sys.exit(f"[crucible] ERROR: CRUCIBLE_PROJECT_KEY not found in {project_dir}/.env")
    return key


def _base_url():
    """The board this client posts to, read at the point of use from the
    fleet's one resolver (`resolve_base_url` in `_crucible_axi.py`)."""
    return _axi().resolve_base_url()


def _request(method, path, payload=None, timeout=None):
    """JSON request to Crucible through the fleet's one transport,
    `_crucible_axi.http_request`. Returns parsed JSON, or {ok:False,error}."""
    return _axi().http_request(_base_url(), method, path, payload, timeout)


def _post(path, payload, timeout=None):
    return _request("POST", path, payload, timeout=timeout)


def _get(path, timeout=10):
    # The read path is bounded by a SHORT hook-safe timeout so an unreachable
    # board can't hang a session-start hook forever.
    return _request("GET", path, timeout=timeout)


def _patch(path, payload):
    return _request("PATCH", path, payload)


# ── the shared TOON-AXI envelope module (loaded by file path) ───────────────

_AXI_MOD = None


def _axi():
    """Lazily load the shared clients/_crucible_axi.py envelope module by path."""
    global _AXI_MOD
    if _AXI_MOD is None:
        axi_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_crucible_axi.py")
        spec = importlib.util.spec_from_file_location(f"{__name__}_axi_shared", axi_path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load shared AXI module at {axi_path}")
        _AXI_MOD = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_AXI_MOD)
    return _AXI_MOD


_AXI_UNSET = _axi().AXI_UNSET

# Go declares no suite: the gate's surface enumerates no declaration, so the
# shared scoped-gate check refuses every `--suites`.
_GATE_SURFACE = _axi().DeclaredTierSurface(
    target="", names="", read=None, run=None, suites=None)


def _axi_context(project_dir, agent_id=None, cr=None, cycle_id=_AXI_UNSET):
    """The envelope context, the project key resolved from `.env` and the rest
    delegated to the shared `axi_context`, so it is byte-identical across
    clients."""
    return _axi().axi_context(
        _project_key(project_dir), agent_id=agent_id, cr=cr, cycle_id=cycle_id)


def _emit_axi(verb, ok, result_fields, context, warnings, legacy_line=None):
    """Write the TOON-AXI envelope (delegates to the shared module)."""
    return _axi().emit_axi(verb, ok, result_fields, context, warnings, legacy_line)


def _ops():
    """This client's own callables, handed to the shared verb implementations.
    Built FRESH per call from the module globals so a test that patches
    `_post`/`_emit_axi`/`_agent_id` is observed."""
    return _axi().ClientOps(
        get=_get, post=_post, patch=_patch,
        emit=_emit_axi, context=_axi_context, agent_id=_agent_id,
        project_key=_project_key, plans_path=_plans_path,
        open_plans=_open_plans, resolve_plan=_resolve_plan_or_emit,
        post_gate=_post_gate, post_milestone=_post_milestone,
        base_url=_base_url())


def _plans_path(project_dir):
    """This project's plans-collection URL (the shared template)."""
    return _axi().plans_path(_project_key(project_dir))


def _open_plans(project_dir):
    """This project's open plans, through the shared reader."""
    return _axi().open_plans(_get, _plans_path(project_dir))


def _resolve_plan_or_emit(verb, project_dir, cr, result_fields, open_only):
    """Resolve exactly ONE target plan for a write verb, or emit the ok:false
    envelope and return `(None, 1)` — a thin delegator to the shared
    `resolve_plan_or_emit`."""
    return _axi().resolve_plan_or_emit(
        verb, cr, result_fields, open_only,
        _get, _plans_path(project_dir), _emit_axi,
        lambda: _axi_context(project_dir, cr=cr))


def _agent_id(args):
    """The agentId for a fleet event: DECLARED (`--agent`) or the verb FAILS,
    through the shared resolver (`require_agent_id`), which raises the typed
    hard stop `main` turns into the ok:false envelope."""
    return _axi().require_agent_id(args)


def _post_gate(project_dir, agent_id, gate, context=None, release=None):
    """POST a gate event through the shared builder."""
    return _axi().post_gate(_project_key(project_dir), agent_id, gate, _post,
                            context, release)


def _post_milestone(project_dir, agent_id, mtype, label=None, commit=None,
                    context=None, released_at=None, crs=None, packages=None,
                    repair_provenance=False):
    """POST a workflow milestone through the shared builder."""
    return _axi().post_milestone(_project_key(project_dir), agent_id, mtype,
                                 _post, label=label, commit=commit,
                                 context=context, released_at=released_at,
                                 crs=crs, packages=packages,
                                 repair_provenance=repair_provenance)


# ── pure readers: the go toolchain's own output ─────────────────────────────

# A name `go test -list` prints for a test it would run: a test, a fuzz test
# or an example. A benchmark is never run by `go test`, and a package summary
# (`ok …`, `? … [no test files]`, `FAIL …`) is no test.
_LISTED_NAME = re.compile(r"^(Test|Fuzz|Example)\S*$")
# A `go version` / `go env GOVERSION` answer: `go1.24.0`, `go1.27.3-X:nodwarf5`,
# `go1.24rc1`.
_GO_VERSION = re.compile(r"go(\d+)\.(\d+)((?:\.\d+)?(?:(?:rc|beta)\d+)?)")


def _json_events(text):
    """(PURE) Every line of `text` that decodes to a `go test -json` event."""
    events = []
    for line in (text or "").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and "Action" in event:
            events.append(event)
    return events


def _count_listed(text):
    """(PURE) The tests `go test -list <re> -json` printed in `text`: its
    `Test*`, `Fuzz*` and `Example*` names, never a benchmark nor a package
    summary line. None when `text` holds no `go test -json` event at all (the
    list could not be read); 0 for a readable list naming no test."""
    events = _json_events(text)
    if not events:
        return None
    return sum(1 for event in events
               if event["Action"] == "output"
               and _LISTED_NAME.match((event.get("Output") or "").strip()))


def _list_pattern(run):
    """(PURE) The regex the run's tests are listed by: `.` without a `run`
    regex, else its top-level element — up to its first `/` outside brackets
    and parentheses, the split Go's own `-run` makes."""
    if not run:
        return "."
    depth = 0
    for i, ch in enumerate(run):
        if ch in "[(":
            depth += 1
        elif ch in "])" and depth:
            depth -= 1
        elif ch == "/" and depth == 0:
            return run[:i]
    return run


def _parse_go_version(text):
    """(PURE) `(version, shown)` from a `go env GOVERSION` / `go version`
    answer: `version` the `(major, minor)` pair, `shown` the version as go
    states it (`1.23.4`). A development toolchain (`devel …`) is newer than
    any release: `version` is None and `shown` is `devel`. An answer naming no
    version gives `(None, <the answer>)`."""
    text = (text or "").strip()
    if text.startswith(("devel", "go version devel")):
        return None, "devel"
    found = _GO_VERSION.search(text)
    if found:
        shown = f"{found.group(1)}.{found.group(2)}{found.group(3)}"
        return (int(found.group(1)), int(found.group(2))), shown
    return None, text


# ── the toolchain, the module, the refusals ────────────────────────────────


def _go_version():
    """`(acceptable, shown)` for the `go` on PATH: `acceptable` when it is at
    or above the floor (a development toolchain is), `shown` the version it
    states. None for `shown` when there is no `go` to ask."""
    try:
        ran = subprocess.run(["go", "env", "GOVERSION"], capture_output=True,
                             text=True, check=False)
    except FileNotFoundError:
        return False, None
    version, shown = _parse_go_version(ran.stdout)
    if version is None:
        return shown == "devel", shown
    return version >= GO_FLOOR, shown


def _declared_module_dir(project_dir):
    """crucible.toml's `[go] module_dir`, or None. A crucible.toml that is
    absent or does not parse declares nothing."""
    try:
        with open(os.path.join(project_dir, "crucible.toml"), "rb") as fh:
            declared = (tomllib.load(fh).get("go") or {}).get("module_dir")
    except FileNotFoundError:
        return None
    except (OSError, tomllib.TOMLDecodeError) as exc:
        print(f"[crucible] WARN: crucible.toml could not be read ({exc}); it "
              f"declares no [go] module_dir", file=sys.stderr)
        return None
    return declared if isinstance(declared, str) and declared else None


def _module_dir(module_dir_arg, project_dir, cwd):
    """`(module_dir, None)` for the module the run is made in, or `(None,
    why)`: --module-dir, else $GO_CRUCIBLE_MODULE_DIR, else the nearest go.mod
    at or above `cwd` and never above `project_dir`, else crucible.toml's
    `[go] module_dir`. A named dir is relative to the project dir and must
    hold a go.mod. The walk compares real paths, so a project dir reached
    through a symlink still bounds it."""
    for source, named in (("--module-dir", module_dir_arg),
                          ("GO_CRUCIBLE_MODULE_DIR",
                           os.environ.get("GO_CRUCIBLE_MODULE_DIR"))):
        if named:
            return _named_module(source, named, project_dir)
    real_project = os.path.realpath(project_dir)
    here = os.path.realpath(cwd)
    while here == real_project or here.startswith(real_project + os.sep):
        if os.path.isfile(os.path.join(here, "go.mod")):
            return here, None
        here = os.path.dirname(here)
    declared = _declared_module_dir(project_dir)
    if declared:
        return _named_module("crucible.toml [go] module_dir", declared, project_dir)
    return None, (f"no go module was found: no go.mod at or above "
                  f"{os.path.abspath(cwd)} within the project dir {project_dir}, "
                  f"and none is declared")


def _named_module(source, named, project_dir):
    """`(module_dir, None)` for the dir `source` names, or `(None, why)` when
    it holds no go.mod."""
    path = os.path.normpath(os.path.join(project_dir, named))
    if os.path.isfile(os.path.join(path, "go.mod")):
        return path, None
    return None, f"{source} names {named!r}, which holds no go.mod"


def _refuse(verb, project_dir, agent, error, help_steps, warnings=()):
    """ONE ok:false envelope for a run refused before anything ran; exit 1."""
    _emit_axi(verb, False, {"error": error, "help": list(help_steps)},
              _axi_context(project_dir, agent_id=agent), list(warnings),
              f"[crucible] ERROR: {error}")
    return 1


# ── verbs ────────────────────────────────────────────────────────────────────


def cmd_register(args):
    """Register / heartbeat. `--cycle` binds the agent to an ACTIVE cycle of
    an OPEN plan; the server REQUIRES it for TDD roles. Delegates to the
    shared implementation, which owns the runtime identity hard stop."""
    return _axi().cmd_register(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_unregister(args):
    """Remove this agent's row (journals an 'unregistered' lifecycle event).
    Delegates to the shared implementation."""
    return _axi().cmd_unregister(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_test(args):
    """Run the module's tests with `go test -json`, streamed to the board.

    Refused before anything runs: a Go below the floor, a module that cannot
    be found, a board that does not decode `go-test`, a board that opens no
    run. Otherwise the run's tests are listed and counted (the run-start
    total), the run is opened, `go test -json` is run with its stdout relayed
    to the open run's stream, and the run is closed from that stream. The
    envelope's figures are the board's close answer; the exit is 1 when the
    runner failed, a test failed or the run was not filed."""
    verb = "test"
    agent = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    _refuse_unattributed(args, project_dir, agent)
    refused = _toolchain_refusal()
    if refused:
        return _refuse(verb, project_dir, agent, *refused)
    module, why = _module_dir(args.module_dir, project_dir, os.getcwd())
    if module is None:
        return _refuse(verb, project_dir, agent, f"{why}; nothing was run",
                       [_MODULE_DECLARATION_HELP])
    return _gated_go_run(verb, args, project_dir, agent, [module])


def cmd_check(args):
    """Compile the module `test` resolves: `go build ./...`, or with `--tests`
    the test compile (`_check_command`) instead. With `--agent` a failing
    compile files its output, stdout and stderr in the order go printed them,
    as ONE compile run of format `go`; a clean one files nothing.

    Refused before go compiles anything: a Go below the floor, a module that
    cannot be found, and with `--tests` a missing no-op for `-exec`. One
    envelope on every path; the exit is go's own on a failing compile."""
    verb = "check"
    agent = args.agent
    project_dir = _resolve_project_dir(args.project_dir)
    refused = _toolchain_refusal()
    if refused:
        return _refuse(verb, project_dir, agent, *refused)
    module, why = _module_dir(args.module_dir, project_dir, os.getcwd())
    if module is None:
        return _refuse(verb, project_dir, agent, f"{why}; nothing was compiled",
                       [_MODULE_DECLARATION_HELP])
    cmd, why = _check_command(args.tests)
    if cmd is None:
        return _refuse(verb, project_dir, agent, why,
                       ["put a `true` binary on PATH, or run check without --tests"])
    cycle = getattr(args, "cycle", None)
    # An ingesting verb: the attribution pre-flight runs before go compiles,
    # while `--cycle` can still be supplied.
    warnings = list(_axi().preflight_cycle_warnings(
        _get, _project_key(project_dir), agent, cycle_id=cycle, context=None))
    print(f"[crucible] running: {' '.join(cmd)} (in {module})", file=sys.stderr)
    result = subprocess.run(cmd, cwd=module, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, check=False)
    ok = result.returncode == 0
    print(f"[crucible] {' '.join(cmd[:2])} exit={result.returncode}", file=sys.stderr)
    if not ok:
        sys.stderr.write(result.stdout)
        if agent:
            _ingest_go_compile(project_dir, agent, result.stdout, cycle)
    _emit_axi(verb, ok, {"exit": result.returncode, "help": _axi().HELP_STEPS["check"]},
              _axi_context(project_dir, agent_id=agent), warnings,
              f"check: ok={ok} exit={result.returncode}")
    return 0 if ok else (result.returncode or 1)


def _check_command(tests):
    """`(cmd, None)` for the compile `check` runs, or `(None, why)`. Without
    `tests` it is `go build ./...`. With `tests` it is the test compile: every
    package and test file compiled, no vet check, no test selected, and the
    test binary handed to a no-op `-exec` (an absolute path, run without a
    shell) so none runs, `TestMain` included."""
    if not tests:
        return ["go", "build", "./..."], None
    no_op = shutil.which("true")
    if no_op is None:
        return None, ("no `true` binary was found on PATH to stand in for the test "
                      "binary (-exec), so the test compile would run the tests; "
                      "nothing was compiled")
    return ["go", "test", "-count=1", "-vet=off", "-run", "^$",
            "-exec", os.path.abspath(no_op), "./..."], None


def _ingest_go_compile(project_dir, agent, output, cycle_id):
    """POST a failing compile's output to /api/v2/runs/compile, format `go`
    (the board decodes it), under `cycle_id` when one is given."""
    payload = {
        "projectKey": _project_key(project_dir),
        "format": "go",
        "errors": output,
        "agentId": agent,
    }
    context = _axi().cycle_context(None, cycle_id)
    if context:
        payload["context"] = context
    resp = _axi().post_ingest(_post, "/api/v2/runs/compile", payload, stack=_STACK)
    print(f"ingest compile (check): ok={resp.get('ok')}", file=sys.stderr)
    return resp


def cmd_regression(args):
    """The full suite: every module under the project dir, run into ONE
    streamed run (see `_gate_run`)."""
    return _gate_run("regression", args)


def cmd_pre_merge_gate(args):
    """ORCHESTRATOR pre-merge gate: the full suite over every module, as
    `regression` runs it, its outcome recorded as the gate's milestone. A gate
    scoped to named suites is refused before anything else: go declares no
    suite, so every `--suites` is."""
    _axi().refuse_unrunnable_scoped_gate(
        args, surface=_GATE_SURFACE, stack=_STACK, get=_get,
        project_key=lambda: _project_key(_resolve_project_dir(args.project_dir)))
    return _gate_run("pre-merge-gate", args)


def _gate_run(verb, args):
    """Run every module under the project dir into one run. `go test ./...`
    cannot span two modules, so each `go.mod` found (`_discover_modules`) has
    its own `./...` run in turn, into the one stream; the run-start total is
    the sum of each module's list."""
    agent = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    _refuse_unattributed(args, project_dir, agent)
    refused = _toolchain_refusal()
    if refused:
        return _refuse(verb, project_dir, agent, *refused)
    modules = _discover_modules(project_dir)
    if not modules:
        return _refuse(verb, project_dir, agent,
                       f"no go module was found: no go.mod under the project dir "
                       f"{project_dir} (outside {', '.join(_SKIPPED_MODULE_DIRS)} "
                       f"and hidden dirs); nothing was run",
                       [("run the gate from the project dir that holds the go modules "
                         "(--project-dir <dir>)")])
    return _gated_go_run(verb, args, project_dir, agent, modules)


def _refuse_unattributed(args, project_dir, agent):
    """Refuse a run the board would file under no cycle (or while a cycle is
    active elsewhere) before the toolchain is touched or anything runs."""
    _axi().refuse_unattributed_run(
        _get, _project_key(project_dir), agent,
        cycle_id=getattr(args, "cycle", None),
        release=getattr(args, "release", None), context=None)


def _toolchain_refusal():
    """`(error, help)` when no `go` at or above the floor is on PATH, else None."""
    acceptable, shown = _go_version()
    if shown is None:
        return ("no `go` toolchain was found on PATH",
                [f"install go {GO_FLOOR_TEXT} or later and put it on PATH"])
    if not acceptable:
        return ((f"go {shown} is older than go {GO_FLOOR_TEXT}, the first whose "
                 f"`go test -json` the board decodes; nothing was run"),
                [f"install go {GO_FLOOR_TEXT} or later"])
    return None


def _discover_modules(project_dir):
    """Every dir under `project_dir` holding a go.mod, sorted, never looking
    in a skipped dir (`_SKIPPED_MODULE_DIRS`) or a hidden one."""
    found = []
    for here, dirs, files in os.walk(project_dir):
        dirs[:] = sorted(d for d in dirs
                         if d not in _SKIPPED_MODULE_DIRS and not d.startswith("."))
        if "go.mod" in files:
            found.append(here)
    return sorted(found)


def _gated_go_run(verb, args, project_dir, agent, modules):
    """The board check and the gated-identity bracket around `_go_test_run`."""
    health = _get("/api/v2/health")
    coverage_codec = GO_COVERAGE_CODEC if getattr(args, "coverage", False) else None
    refused = _axi()._ingest_health_refusal(health, GO_TEST_CODEC, coverage_codec)
    if refused:
        codecs = " and ".join(f"`{name}`" for name in (GO_TEST_CODEC, coverage_codec)
                              if name)
        return _refuse(verb, project_dir, agent, refused,
                       [f"point the project at a board that decodes {codecs}"])
    with _axi().gated_run(project_dir, agent, getattr(args, "cycle", None),
                          f"gated {verb} run starting",
                          open_fn=_open_gate_identity,
                          close_fn=_close_gate_identity):
        return _go_test_run(verb, args, project_dir, agent, modules, health)


def _open_gate_identity(project_dir, agent_id, cycle_id, message):
    """Open a gated run's identity and learn whether the run CREATED it.
    Delegates to the shared implementation."""
    return _axi().open_gate_identity(project_dir, agent_id, cycle_id, message, _ops())


def _close_gate_identity(project_dir, identity):
    """The closing half of the gated-run bracket. Delegates to the shared
    implementation."""
    return _axi().close_gate_identity(project_dir, identity, _ops())


def _runner_command(modules, run, project_dir, profiles=None):
    """`(cmd, cwd)` running `go test -json ./...`: directly in the one module,
    or each module in turn through `_EACH_MODULE_RUNNER`. With `profiles`
    (one path per module), each module's call writes its coverprofile there."""
    extras = [[f"-coverprofile={profile}"] for profile in profiles] if profiles \
        else [[] for _module in modules]
    if len(modules) == 1:
        return (["go", "test", "-json", *(["-run", run] if run else []),
                 *extras[0], "./..."], modules[0])
    return ([sys.executable, "-c", _EACH_MODULE_RUNNER,
             json.dumps([[module, extra] for module, extra in zip(modules, extras, strict=True)])],
            project_dir)


def _coverage_profiles(own_dir, modules):
    """One coverprofile path per module, in the run's own reports dir, each
    removed first so a profile go did not write is never a stale one."""
    profiles = [os.path.join(own_dir, f"go-coverprofile-{index}.out")
                for index in range(len(modules))]
    for profile in profiles:
        if os.path.exists(profile):
            os.remove(profile)
    return profiles


def _written_profiles(modules, profiles):
    """`(paths, warnings)`: every module's profile when go wrote them all;
    otherwise no path and one warning naming each module whose profile was
    not written, so a run never carries a partial total."""
    unwritten = [module for module, profile in zip(modules, profiles, strict=True)
                 if not os.path.isfile(profile)]
    if not unwritten:
        return list(profiles), []
    return [], [_axi().coverage_not_measured_warning(
        f"go wrote no coverprofile for the module(s) {', '.join(unwritten)}")]


def _go_test_run(verb, args, project_dir, agent, modules, health):
    """List, open, run with the stream relayed, close: the body of a run
    once nothing refuses it. Returns the verb's exit code."""
    key = _project_key(project_dir)
    release = getattr(args, "release", None)
    run = getattr(args, "run", None)
    warnings = list(_axi().preflight_cycle_warnings(
        _get, key, agent, cycle_id=getattr(args, "cycle", None), context=None,
        release=release))
    totals = [_listed_total(module, run, warnings) for module in modules]
    listed = [count for count in totals if count is not None]
    total = sum(listed) if len(listed) == len(totals) else None
    if run and total == 0:
        # The board never stores a stream with no test: refuse before opening.
        return _refuse(verb, project_dir, agent,
                       f"--run {run!r} matched no test: the go test list names "
                       f"none, so no run was opened and nothing was run",
                       ["re-run test --run <regex> with a regex that matches a test",
                        "status"], warnings)
    run_id, opened = _axi().open_run(_start_post(total), key, agent, _STACK,
                                     framework=GO_TEST_CODEC, release=release)
    warnings += opened
    if not run_id:
        return _refuse(verb, project_dir, agent,
                       f"the board at {_base_url()} opened no run; nothing was run",
                       ["status"], warnings)
    own_dir = _axi().run_reports_dir(project_dir, args.reports, agent)
    os.makedirs(own_dir, exist_ok=True)
    stream_path = os.path.join(own_dir, _STREAM_FILE)
    open(stream_path, "w", encoding="utf-8").close()
    coverage = bool(getattr(args, "coverage", False))
    profiles = _coverage_profiles(own_dir, modules) if coverage else None
    run_cmd, run_cwd = _runner_command(modules, run, project_dir, profiles)
    relay = None
    try:
        with _axi().abandon_trap(run_id):
            # The narrator counts no `go-test` event, so the run's in-flight
            # ticks are not posted: the relay's batches are the run's progress.
            relay, _narrator = _axi().start_stream_relay(
                _post, lambda *_a, **_k: None, key, agent, run_id, stream_path,
                GO_TEST_CODEC, _axi()._ingest_body_limit(health))
            print(f"[crucible] running: go test -json ./... (in "
                  f"{', '.join(modules)})", file=sys.stderr)
            result = _axi().run_streamed(run_cmd, run_cwd, dict(os.environ),
                                         getattr(args, "log", None),
                                         capture=True, stdout_path=stream_path)
    except _axi().RunAbandoned as abandoned:
        # What the run streamed before the signal reaches the board first.
        if relay is not None:
            relay.finish(_INTERRUPTED_FINISH_SECONDS)
        return _axi().emit_run_abandoned(verb, key, agent, run_id, abandoned,
                                         warnings, post_fn=_post)
    except BaseException:
        if relay is not None:
            relay.finish(0)
        raise
    relay.finish(_STREAM_FINISH_SECONDS)
    print(f"[crucible] go test exit={result.returncode}", file=sys.stderr)
    runner_exit = _axi().runner_exit_code(result.returncode)
    coverage_paths = []
    if coverage:
        coverage_paths, missing = _written_profiles(modules, profiles)
        warnings += missing
    resp = _axi().close_stream(_post, stack=_STACK, project_key=key, agent_id=agent,
                               run_id=run_id, codec=GO_TEST_CODEC,
                               raw=result.stdout or None, runner_exit=runner_exit,
                               coverage_codec=GO_COVERAGE_CODEC if coverage_paths else None,
                               coverage_paths=coverage_paths,
                               framework=GO_TEST_CODEC, release=release)
    exit_code = _axi().verb_exit(runner_exit, resp)
    if not resp.get("ok"):
        warnings.append(_axi().ingest_failed_warning(verb, _base_url()))
    _axi().emit_run_axi(
        verb, resp,
        _axi_context(project_dir, agent_id=agent,
                     cycle_id=_axi().echoed_cycle_id(resp)),
        _emit_axi,
        help_steps=_axi().run_help(verb, exit_code == 0,
                                   _axi().filed_run(resp).get("failed"), _base_url()),
        warnings=warnings, fields={})
    return exit_code


def _listed_total(module, run, warnings):
    """The run-start total: the names `go test -list` prints for the run's
    tests, or None (a warning added to `warnings`) when the list cannot be
    read. A list that exits non-zero still counts the names it printed."""
    list_cmd = ["go", "test", "-list", _list_pattern(run), "-json", "./..."]
    print(f"[crucible] listing: {' '.join(list_cmd)} (in {module})", file=sys.stderr)
    listed = subprocess.run(list_cmd, cwd=module, capture_output=True, text=True,
                            check=False)
    if listed.stderr:
        sys.stderr.write(listed.stderr)
    total = _count_listed(listed.stdout)
    if total is None:
        warnings.append({"code": "go-list-unreadable",
                         "detail": ("the go test list could not be read (no "
                                    "`go test -list -json` event was printed); "
                                    "the run starts with no total, so no "
                                    "completeness check is made against it")})
    return total


def _start_post(total):
    """`_post`, with the run start carrying `total` when one was listed."""
    if total is None:
        return _post

    def post(path, payload, timeout=None):
        if path == _axi().RUN_START_PATH:
            payload = {**payload, "total": total}
        return _post(path, payload, timeout=timeout)
    return post


# ── gate verbs: thin delegators to the shared module ─────────────────────────


def cmd_gate_report(args):
    """Report a single already-run gate. Delegates to the shared implementation."""
    return _axi().cmd_gate_report(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_gate_run(args):
    """axi PROXY around `no-mistakes axi run`. Delegates to the shared
    implementation; tool discovery stays here (this module's own `shutil`) so
    each client keeps its patch seam."""
    return _axi().cmd_gate_run(
        args, _resolve_project_dir(args.project_dir), shutil.which("no-mistakes"), _ops())


def cmd_gate_respond(args):
    """axi PROXY around `no-mistakes axi respond`. Delegates to the shared
    implementation; tool discovery stays here, as for `gate-run`."""
    return _axi().cmd_gate_respond(
        args, _resolve_project_dir(args.project_dir), shutil.which("no-mistakes"), _ops())


def cmd_milestone(args):
    """POST a workflow milestone. Delegates to the shared implementation."""
    return _axi().cmd_milestone(args, _resolve_project_dir(args.project_dir), _ops())


# ── plan / cycle / status verbs: thin delegators to the shared module ──────


def cmd_plan_file(args):
    """File a workflow plan (CR + its cycles). Delegates to the shared implementation."""
    return _axi().cmd_plan_file(args, _resolve_project_dir(args.project_dir), _ops())


def _cycle_transition(args, status):
    """Transition a cycle to `status`. Delegates to the shared implementation."""
    return _axi().cycle_transition(args, _resolve_project_dir(args.project_dir), _ops(), status)


def cmd_cycle_activate(args):
    return _cycle_transition(args, "active")


def cmd_cycle_done(args):
    return _cycle_transition(args, "done")


def cmd_cycle_skip(args):
    """Mark a PENDING cycle skipped. Delegates to the shared implementation."""
    return _axi().cmd_cycle_skip(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_cr_close(args):
    """Close the resolved OPEN plan and post the cr-merged milestone. Go
    declares no tier, so no declared-gate surface is handed on. Delegates to
    the shared implementation."""
    return _axi().cmd_cr_close(args, _resolve_project_dir(args.project_dir), _ops(),
                               stack=_STACK)


def cmd_cycle_add(args):
    """Append a cycle to the resolved plan. Delegates to the shared implementation."""
    return _axi().cmd_cycle_add(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_checkpoint(args):
    """Checkpoint the resolved OPEN plan. Delegates to the shared implementation."""
    return _axi().cmd_checkpoint(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_stop(args):
    """Project-level stop. Delegates to the shared implementation."""
    return _axi().cmd_stop(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_abort(args):
    """Abort the resolved OPEN plan. Delegates to the shared implementation."""
    return _axi().cmd_abort(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_status(args):
    """The work-in-flight READ verb (alias `plans`). Delegates to the shared implementation."""
    return _axi().cmd_status(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_queue(args):
    """The registered CR queue READ verb. Delegates to the shared implementation."""
    return _axi().cmd_queue(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_landings(args):
    """The closed plans' merge commits READ verb. Delegates to the shared implementation."""
    return _axi().cmd_landings(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_history(args):
    """A project's releases READ verb. Delegates to the shared implementation."""
    return _axi().cmd_history(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_runs(args):
    """List a cycle's or a release's stored runs. Delegates to the shared implementation."""
    return _axi().cmd_runs(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_run(args):
    """Show one stored run. Delegates to the shared implementation."""
    return _axi().cmd_run(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_project_meta(args):
    """A project's metadata map, read or written. Delegates to the shared implementation."""
    return _axi().cmd_project_meta(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_release_propose(args):
    """Record or revise a proposed release. Delegates to the shared implementation."""
    return _axi().cmd_release_propose(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_cr_plan(args):
    """Declare one CR's release, wave and title. Delegates to the shared implementation."""
    return _axi().cmd_cr_plan(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_wave_sequence(args):
    """Author a whole wave's order. Delegates to the shared implementation."""
    return _axi().cmd_wave_sequence(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_cr_depends(args):
    """Declare one CR's complete dependency set. Delegates to the shared implementation."""
    return _axi().cmd_cr_depends(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_cr_supersede(args):
    """Record that a CR's work moves to a successor. Delegates to the shared implementation."""
    return _axi().cmd_cr_supersede(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_cr_void(args):
    """Record that a CR's work is not happening. Delegates to the shared implementation."""
    return _axi().cmd_cr_void(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_next(args):
    """Ask the declared roadmap what is actionable now (NEXT | HOLD |
    DRAINED). Read-only. Delegates to the shared implementation."""
    return _axi().cmd_next(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_queue_file(args):
    """Register the project's CR queue. Delegates to the shared implementation."""
    return _axi().cmd_queue_file(args, _resolve_project_dir(args.project_dir), _ops())


_DASHBOARD_PURPOSE_LINE = (
    "go-crucible.py -- Go Crucible CLI "
    "(agent lifecycle, test/ingest, plan/cycle verbs)."
)


def cmd_dashboard():
    """A bare invocation (no args) returns the LIVE board: the status
    dashboard on stdout, plus a one-line tool purpose + the executable path
    on stderr."""
    print(_DASHBOARD_PURPOSE_LINE, file=sys.stderr)
    print(_axi().abbrev_home(os.path.abspath(__file__)), file=sys.stderr)
    return cmd_status(_axi().status_namespace())


# ── argument surface ────────────────────────────────────────────────────────


def _add_project_dir_arg(p):
    p.add_argument(
        "--project-dir",
        help="Override project root (default: $GO_CRUCIBLE_PROJECT_DIR, else the git "
             "repo containing the current directory). The .env at the project root must "
             "contain CRUCIBLE_PROJECT_KEY.",
    )


def _add_workflow_agent_arg(p, extra=""):
    """The shared `--agent` flag for workflow verbs: every mutating workflow
    verb posts as a LIVE registered caller and hard-stops client-side when the
    identity is undeclared."""
    p.add_argument(
        "--agent",
        help="Registered agent id — REQUIRED: every workflow verb posts as a "
             "live registered caller; the identity is declared or the verb fails, "
             "with no fallback. An unregistered id is refused by the server (409)."
             + extra,
    )


_CLI_DESCRIPTION = (
    "Go Crucible CLI — one entry point for the orchestrator and for the "
    "go-{red,green,fix,verify} agent lifecycle, and for running a Go module's "
    "tests with the result streamed to Crucible.\n\n"
    "Tool-specific (the Go toolchain), never project-specific: the project "
    "path is parameterizable. Run `<verb> --help` for a verb's own flags.\n\n"
    f"`test` needs go {GO_FLOOR_TEXT} or later (an older one is refused): it lists "
    "the run's tests with `go test -list`, runs them with `go test -json` and "
    "the board files the run from that stream, decoded by its `go-test` codec. "
    "The module is --module-dir, else GO_CRUCIBLE_MODULE_DIR, else the nearest "
    "go.mod at or above the working directory within the project, else the "
    "project's crucible.toml [go] module_dir.\n\n"
    + _axi().BOARD_CONFIGURATION_HELP
)


def _add_lifecycle_verbs(sub):
    """`register`, `unregister` and `test`."""
    r = sub.add_parser("register",
                       help="Register / heartbeat an agent. TDD roles must bind a "
                            "cycle with --cycle.")
    r.add_argument(
        "--agent",
        help="Agent id — a free-form identifier. REQUIRED, but enforced at RUNTIME "
             "so a missing id yields the ok:false AXI envelope, not a bare argparse "
             "usage error. The role is declared by --role and is never inferred "
             "from the agentId's shape.")
    r.add_argument(
        "--role",
        choices=["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"],
        required=True,
        help="Declared role — the ONLY role channel. Use `report` for a registration "
             "that is not exercising a TDD role.")
    r.add_argument(
        "--cycle", type=int,
        help="Cycle id to BIND this agent to (an ACTIVE cycle of an OPEN plan). "
             "TDD roles (RED/GREEN/FIX/VERIFY) MUST bind — the server refuses an "
             "unbound TDD registration (409). ORCHESTRATOR/report may register "
             "unbound. A bound agent's ingests are server-stamped with this cycle.")
    r.add_argument("--source", default="claude-md",
                   choices=["claude-md", "package-json", "git-repo", "manual"],
                   help="Identity discovery source per agent-protocol (default: claude-md)")
    r.add_argument("--message", help="Optional status message")
    _add_project_dir_arg(r)
    r.set_defaults(func=cmd_register)

    u = sub.add_parser("unregister", help="Unregister an agent")
    u.add_argument("--agent",
                   help="Agent id — REQUIRED, but enforced at RUNTIME so a missing "
                        "id yields the ok:false AXI envelope, not a bare argparse "
                        "usage error.")
    _add_project_dir_arg(u)
    u.set_defaults(func=cmd_unregister)

    t = sub.add_parser(
        "test",
        help="go test -json ./... in the run's module, streamed to the board.")
    t.add_argument("--agent",
                   help="Registered agent id to file the run under — REQUIRED, "
                        "enforced at RUNTIME.")
    t.add_argument("--run",
                   help="Go's own -run regex: only the tests it matches run. Its "
                        "top-level element (before the first unbracketed `/`) "
                        "selects the tests listed for the run's total.")
    t.add_argument("--module-dir",
                   help="The module to run, relative to the project dir (default: "
                        "$GO_CRUCIBLE_MODULE_DIR, else the nearest go.mod at or above "
                        "the working directory, else crucible.toml [go] module_dir).")
    t.add_argument("--log",
                   help="Write the run's stderr to this file in addition to "
                        "streaming it.")
    t.add_argument("--reports", help=_REPORTS_HELP)
    t.add_argument("--coverage", action="store_true",
                   help="Write the module's coverprofile (go test -coverprofile) in "
                        "the run's reports dir and send it with the run's close as "
                        "go-coverprofile: statement coverage, on the lines axis.")
    _add_gate_cycle_arg(t)
    _axi().add_run_release_arg(t)
    _add_project_dir_arg(t)
    t.set_defaults(func=cmd_test)

    c = sub.add_parser(
        "check",
        help="Compile the run's module (go build ./...); a failing compile is "
             "filed as a go compile run.")
    c.add_argument("--agent",
                   help="Registered agent id to file a failing compile under; "
                        "without one nothing is filed.")
    c.add_argument("--tests", action="store_true",
                   help="Compile every package and test file instead (go test "
                        "-count=1 -vet=off -run '^$' with a no-op -exec): no test "
                        "runs and no vet check runs.")
    c.add_argument("--module-dir",
                   help="The module to compile, relative to the project dir "
                        "(default: $GO_CRUCIBLE_MODULE_DIR, else the nearest go.mod "
                        "at or above the working directory, else crucible.toml "
                        "[go] module_dir).")
    _axi().add_filing_cycle_arg(c)
    _add_project_dir_arg(c)
    c.set_defaults(func=cmd_check)


def _add_gate_cycle_arg(p):
    """Bind `--cycle` on a gated verb (delegates to the shared binding so the
    fleet documents it identically)."""
    return _axi().add_gate_cycle_arg(p)


_REPORTS_HELP = (_axi().REPORTS_HELP
                 + " A run keeps its go test stream here: one file, whichever "
                   "modules the run spans.")


def _add_gate_verbs(sub):
    """`regression` and `pre-merge-gate`: the full suite over every module
    under the project dir, into one run. Go declares no tier, so these are
    its only suite-wide run verbs."""
    for name, func, help_text in (
            ("regression", cmd_regression,
             ("go test -json ./... in EVERY module under the project dir (skipping "
              "vendor, testdata, node_modules and hidden dirs), into one run "
              "streamed to the board.")),
            ("pre-merge-gate", cmd_pre_merge_gate,
             ("ORCHESTRATOR pre-merge gate: the regression over every module, its "
              "outcome posted as the pre-merge-gate milestone."))):
        g = sub.add_parser(name, help=help_text)
        g.add_argument("--agent",
                       help="Registered agent id to file the run under — REQUIRED, "
                            "enforced at RUNTIME.")
        g.add_argument("--log",
                       help="Write the run's stderr to this file in addition to "
                            "streaming it.")
        g.add_argument("--reports", help=_REPORTS_HELP)
        if name == "regression":
            g.add_argument("--coverage", action="store_true",
                           help="Write each module's coverprofile (go test "
                                "-coverprofile) in the run's reports dir and send "
                                "them all with the run's close as go-coverprofile; "
                                "a module whose profile was not written leaves the "
                                "run with no coverage.")
        _add_gate_cycle_arg(g)
        _axi().add_run_release_arg(g)
        if name == "pre-merge-gate":
            _axi().add_gate_suites_arg(g)
        _add_project_dir_arg(g)
        g.set_defaults(func=func)


def _add_gate_proxy_verbs(sub):
    """`gate-run`, `gate-respond`, `gate-report` and `milestone`, as the rust
    client registers them."""
    gr = sub.add_parser("gate-run",
                        help="axi PROXY: run `no-mistakes axi run`, post throttled interim "
                             "+ final gates, relay the axi detail to the caller.")
    gr.add_argument("--intent", required=True, help="The intent/goal passed down to `axi run`.")
    gr.add_argument("--agent", help="Agent id for the gate events — REQUIRED: the "
                          "identity is declared or the verb fails; there is "
                          "no fallback.")
    gr.add_argument("--skip", help="Pipeline steps to skip, forwarded VERBATIM to "
                          "`no-mistakes axi run --skip` (pure passthrough — the "
                          "client never validates or rewrites the value). Exists "
                          "because no-mistakes' `ci` step is PR-based, and a "
                          "git-flow project that merges directly has no PR for it "
                          "to watch — skipping nothing, the gate blocks until "
                          "ci_timeout. Omitted, the project's declared "
                          "`[gate] skip` (crucible.toml) applies; a value "
                          "REPLACES it, and --skip \"\" skips nothing.")
    _axi().add_gate_release_arg(gr)
    _add_project_dir_arg(gr)
    gr.set_defaults(func=cmd_gate_run)

    _axi().add_gate_respond_verb(sub, cmd_gate_respond,
                                 add_args=(_add_workflow_agent_arg, _add_project_dir_arg))

    grp = sub.add_parser("gate-report",
                         help="Report a single already-run gate → POST /api/v2/gates.")
    grp.add_argument("--outcome", required=True,
                     help="Gate outcome (checks-passed|passed|failed|cancelled).")
    grp.add_argument("--commit", help="The pushed commit sha (gate.push.commit).")
    grp.add_argument("--steps", help='Comma-separated "name:status" step results.')
    grp.add_argument("--intent", help="Gate intent (default: derived from --outcome).")
    grp.add_argument("--agent", help="Agent id — REQUIRED: the identity is declared or "
                         "the verb fails; there is no fallback.")
    grp.add_argument("--full", action="store_true",
                     help="Emit large text fields (e.g. a server error detail) untruncated.")
    _axi().add_gate_release_arg(grp)
    _add_project_dir_arg(grp)
    grp.set_defaults(func=cmd_gate_report)

    ms = sub.add_parser("milestone", help="POST a workflow milestone → /api/v2/milestones.")
    ms.add_argument("--type", required=True,
                    help="Milestone type. The vocabulary is this project's own, not this "
                         "CLI's: PATCH /api/v2/projects/<key> {milestoneTypes: [...]} "
                         "declares it, GET /api/v2/projects reads back what this project "
                         "declared, and a refused milestone names the live accepted set "
                         "back to you.")
    ms.add_argument("--label", help="Human-readable milestone label.")
    ms.add_argument("--cr", help="CR id (rides context.cr).")
    ms.add_argument("--commit", help="Optional commit sha.")
    ms.add_argument("--released-at", dest="released_at", type=int,
                    help="Release SHIP date: the tag's own commit date in epoch "
                         "SECONDS (`git log -1 --format=%%ct <tag>`), which is "
                         "when the release shipped rather than when it was "
                         "recorded.")
    ms.add_argument("--crs",
                    help="Comma-separated CR ids the release shipped (the merges "
                         "in its tag range). Only the ids the project's "
                         "registered queue holds are recorded.")
    ms.add_argument("--packages",
                    help="Comma-separated `registry:name:version` entries the "
                         "release DELIVERED, e.g. `pypi:crucible-axi:0.4.0,"
                         "npm:@anthill-tec/crucible-server:0.4.0`. Pass an "
                         "empty string to record that it delivered none "
                         "— on a recording only: with "
                         "--repair-provenance an empty value writes nothing "
                         "(it never overwrites a stored set) and the repair is "
                         "REFUSED.")
    ms.add_argument("--repair-provenance", dest="repair_provenance",
                    action="store_true",
                    help="RE-DERIVE an already-recorded release's provenance "
                         "from this post's --released-at/--crs instead of "
                         "replaying it. Opt-in and non-default; the release's "
                         "version, commit and row are never touched.")
    ms.add_argument("--agent", help="Agent id — REQUIRED: the identity is declared or "
                         "the verb fails; there is no fallback.")
    _add_project_dir_arg(ms)
    ms.set_defaults(func=cmd_milestone)


def _add_plan_verbs(sub):
    """The plan / cycle / status verbs and the roadmap verbs, the shared
    module's registrars used wherever one exists."""
    pf = sub.add_parser("plan-file",
                        help="File a cycle plan; prints the ASSIGNED numeric cycle ids. "
                             "Requires --agent <registered id>.")
    pf.add_argument("--cr", required=True,
                    help="CR id — caller-owned free text, e.g. CR-<PROJECT>-<n>.")
    pf.add_argument("--title", help="Optional plan title.")
    pf.add_argument("--cycle", action="append",
                    help="One cycle label, never split; repeat --cycle per cycle.")
    _axi().add_plan_file_cycle_kind_arg(pf)
    pf.add_argument(
        "--cycles",
        help='Legacy comma-split form, REFUSED for filing (§S4a): a filed '
             'cycle declares its kind, so repeat --cycle with its own '
             '--cycle-kind instead.')
    _add_workflow_agent_arg(
        pf, extra=" The registered id is also stored as the plan's orchestrator.")
    pf.add_argument("--wave", help="Wave number. Resolution: --wave > $WORKFLOW_WAVE.")
    _axi().add_plan_file_release_arg(pf)
    _add_project_dir_arg(pf)
    pf.set_defaults(func=cmd_plan_file)

    for name, func, help_text in (
            ("cycle-activate", cmd_cycle_activate, "Transition a plan cycle to active."),
            ("cycle-done", cmd_cycle_done, "Transition an ACTIVE plan cycle to done.")):
        cv = sub.add_parser(name, help=help_text + " Requires --agent <registered id>.")
        cv.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
        _add_workflow_agent_arg(cv)
        _add_project_dir_arg(cv)
        cv.set_defaults(func=func)

    _axi().add_cycle_skip_verb(sub, cmd_cycle_skip,
                               add_args=(_add_workflow_agent_arg, _add_project_dir_arg))

    cc = sub.add_parser("cr-close",
                        help="Close the single OPEN plan (PATCH status=closed + "
                             "merge.commit). Requires --agent <registered id>.")
    cc.add_argument("--commit", required=True, help="Merge commit sha.")
    cc.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _axi().add_cr_close_gate_arg(cc)
    _add_workflow_agent_arg(cc, extra=" The same id posts the closing cr-merged milestone.")
    _add_project_dir_arg(cc)
    cc.set_defaults(func=cmd_cr_close)

    cad = sub.add_parser("cycle-add",
                         help="Append a cycle to a plan; prints the ASSIGNED numeric id. "
                              "Requires --agent <registered id>.")
    cad.add_argument("label", help="Label for the new cycle.")
    cad.add_argument("--cr", help="Disambiguate when multiple plans exist.")
    _axi().add_cycle_add_target_args(cad)
    _add_workflow_agent_arg(cad)
    _add_project_dir_arg(cad)
    cad.set_defaults(func=cmd_cycle_add)

    cp = sub.add_parser("checkpoint",
                        help="Checkpoint the resolved OPEN plan. "
                             "Requires --agent <registered id>.")
    cp.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_workflow_agent_arg(cp)
    _add_project_dir_arg(cp)
    cp.set_defaults(func=cmd_checkpoint)

    stp = sub.add_parser("stop",
                         help="Stop the project — checkpoint every open plan. "
                              "Requires --agent <registered id>.")
    _add_workflow_agent_arg(stp)
    _add_project_dir_arg(stp)
    stp.set_defaults(func=cmd_stop)

    ab = sub.add_parser("abort",
                        help="Abort the resolved OPEN plan. Requires --user-approved "
                             "and --agent <registered id>.")
    ab.add_argument("--user-approved", action="store_true",
                    help="Map to body userApproved:true (the server refuses without it).")
    ab.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _axi().add_change_record_args(ab)
    _add_workflow_agent_arg(ab)
    _add_project_dir_arg(ab)
    ab.set_defaults(func=cmd_abort)

    for name in ("status", "plans"):
        sv = sub.add_parser(name,
                            help="Read the open plans, the work in flight, as a TOON-AXI "
                                 "table + lastClosedCr (the last CR to close) and filed "
                                 "(the project's plan count). Read-only; `plans` is "
                                 "an alias of `status`; --format json writes one JSON "
                                 "object.")
        sv.add_argument("--fields",
                        help="Comma-separated EXTRA columns to add to the minimal "
                             "cr,wave,status,activeCycleId set.")
        _add_project_dir_arg(sv)
        _axi().add_status_format_arg(sv)
        sv.set_defaults(func=cmd_status)

    qv = sub.add_parser("queue",
                        help="Read the registered CR queue plus the cr-merged milestone "
                             "ids as a TOON-AXI table. Read-only.")
    _add_project_dir_arg(qv)
    _axi().add_queue_view_args(qv)
    qv.set_defaults(func=cmd_queue)

    lv = sub.add_parser("landings",
                        help="The closed plans and the merge commit each recorded. "
                             "Read-only.")
    _add_project_dir_arg(lv)
    _axi().add_status_format_arg(lv)
    lv.set_defaults(func=cmd_landings)

    hv = sub.add_parser("history",
                        help="A project's releases, their states, waves, gate runs and "
                             "verification, as a TOON-AXI table. Read-only.")
    _add_project_dir_arg(hv)
    _axi().add_history_args(hv)
    hv.set_defaults(func=cmd_history)

    pmv = sub.add_parser("project-meta",
                         help="A project's metadata map. No flags reads it; --set "
                              "KEY=VALUE / --unset KEY write it (requires --agent).")
    _axi().add_project_meta_args(pmv)
    pmv.add_argument("--agent",
                     help="Registered agent id — required only for a write "
                          "(--set/--unset).")
    _add_project_dir_arg(pmv)
    pmv.set_defaults(func=cmd_project_meta)

    _axi().add_roadmap_verbs(
        sub,
        {"release-propose": cmd_release_propose, "cr-plan": cmd_cr_plan,
         "wave-sequence": cmd_wave_sequence, "cr-supersede": cmd_cr_supersede,
         "cr-void": cmd_cr_void},
        add_args=(_add_workflow_agent_arg, _add_project_dir_arg))
    _axi().add_cr_depends_verb(
        sub, cmd_cr_depends,
        add_args=(_add_workflow_agent_arg, _add_project_dir_arg))
    _axi().add_next_verb(sub, cmd_next, add_args=(_add_project_dir_arg,))
    _axi().add_run_read_verbs(sub, {"runs": cmd_runs, "run": cmd_run},
                              add_args=(_add_project_dir_arg,))
    _axi().add_queue_file_verb(sub, cmd_queue_file, add_args=(_add_project_dir_arg,))


def main():
    p = argparse.ArgumentParser(prog="go-crucible", description=_CLI_DESCRIPTION)
    # The subcommand is OPTIONAL: a bare invocation falls through to the live
    # dashboard, never argparse's required-subcommand error.
    sub = p.add_subparsers(dest="cmd", required=False)
    _add_lifecycle_verbs(sub)
    _add_plan_verbs(sub)
    _add_gate_verbs(sub)
    _add_gate_proxy_verbs(sub)

    args = p.parse_args()
    if getattr(args, "func", None) is None:
        sys.exit(_axi().run_dashboard(
            cmd_dashboard,
            lambda a: _project_key(_resolve_project_dir(getattr(a, "project_dir", None)))))
    # Dispatch through the shared `run_verb`, which turns a typed hard stop
    # (an undeclared agent identity among them) into the ok:false envelope +
    # a non-zero exit instead of an unhandled traceback.
    sys.exit(_axi().run_verb(
        args.func, args,
        lambda a: _project_key(_resolve_project_dir(getattr(a, "project_dir", None))),
        ops_fn=_ops,
        project_dir_fn=lambda a: _resolve_project_dir(getattr(a, "project_dir", None))))


if __name__ == "__main__":
    main()
