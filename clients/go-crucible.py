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
                        test compile, then the same compile under
                        -tags <tier> for each declared tier; no test and no
                        vet check run); with --agent the failing compiles
                        are filed as one compile run, format `go`, each
                        error once.
  unit, module, integration, e2e, bdd
                        The tier verbs. A tier is declared by build tag:
                        `//go:build <tier>` in a `_test.go` file that
                        declares a test. The verb runs only the tests the tag
                        adds, in every module that declares the tier (or the
                        one --module-dir names), into ONE run filed under the
                        tier. A tier no module declares is refused.
  regression            ONE run filed under `regression`: go test -json ./...
                        in every module under the project dir, then each
                        declared tier's tests (`e2e` included), each invoked
                        as its tier verb invokes it. --coverage merges every
                        invocation's coverprofile into one.
  pre-merge-gate        The gate, through the shared composition: `untagged`
                        (the untagged run of every module, filed under
                        `regression`) is the whole run; each declared tier
                        runs as a suite of its own, under its tier; `e2e` is
                        listed and excluded. A project that declares no tier
                        has no suite, so its gate is the untagged run alone.
  plan / cycle / status verbs, the roadmap verbs and `next`: the fleet's
                        shared implementations, one thin delegator each.

A tier's tests:
  A package's tier files are the test files `go list -tags <tier>` names and
  the untagged `go list` does not. The tier's tests are the top-level `Test*`,
  `Fuzz*` and `Example*`-with-an-output-comment functions those files declare,
  read from the source (never a benchmark, never `TestMain`), so a tier file
  that does not compile still has its tests and its build failure reaches the
  run. Each package is run as `go test -json -tags <tier> -run '^(<names>)$'
  <package>` (`-run '^$'` when its tier files declare no test), its names
  split across invocations under a byte budget; the run's start total is the
  number of the tier's tests. A tier test whose name a test file both builds
  compile also declares, in the same package dir, cannot be run alone and is
  refused before anything runs.

The run's total:
  Before a `test` or `regression` run the client lists the run's tests (`go test -list <re> -json
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
  Posts to the first `[client] url` declared by the project's crucible.toml,
  then the install's (with neither declaring one, a verb that must reach the
  board refuses); v2 endpoints ONLY: /api/v2/agents/register|unregister,
  /api/v2/runs/start, the run's
  /stream (codec go-test) and /api/v2/runs (the stream's close).
  The client parses no test result; the board decodes go's own stream.

Examples:
  go-crucible.py register --agent <agentId> --role RED --cycle <cycleId>
  go-crucible.py test --agent <agentId>
  go-crucible.py test --agent <agentId> --run 'TestParse/empty'
  go-crucible.py test --agent <agentId> --module-dir services/api
"""

# pi-lens-ignore: I001 — pi-lens lints with its own ruff configuration, which sets no target version, so ruff files `tomllib` as third-party whatever the declared floor
import argparse  # noqa: I001
import collections
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
# The runner a tier run of several invocations starts: each `[cwd, argv]` of
# the JSON list in the file its one argument names, in turn, its stdout the
# one run's stream. The list rides a file, never an argument, because a large
# tier's names would overflow the per-argument limit. A failing invocation
# does not stop the next; the exit is the worst any gave. Each is narrated as
# the command it runs, a `-run` value too long to read given as its count of
# names.
_EACH_INVOCATION_RUNNER = r"""
import json, shlex, subprocess, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    invocations = json.load(handle)
worst = 0
for cwd, argv in invocations:
    shown = [f"<{arg.count('|') + 1} names>"
             if before == "-run" and len(arg) > 80 else arg
             for before, arg in zip([None, *argv], argv)]
    print(f"[crucible] running: {shlex.join(shown)} (in {cwd})",
          file=sys.stderr, flush=True)
    code = subprocess.run(argv, cwd=cwd, check=False).returncode
    worst = max(worst, code if code >= 0 else 128 - code)
sys.exit(worst)
"""
# The file, in the run's own reports dir, a tier run's invocations are written
# to for `_EACH_INVOCATION_RUNNER`.
_INVOCATIONS_FILE = "go-tier-invocations.json"
# The byte budget one `-run` argument of a tier invocation stays under: well
# below Linux's 128 KiB per-argument limit, so a tier of many tests is split
# across invocations rather than refused.
_RUN_ARG_BUDGET = 32 * 1024
# A top-level function declaration (never a method, never a generic): its name.
_DECLARED_FUNC = re.compile(r"^func[ \t]+([^\W\d]\w*)[ \t]*\(", re.MULTILINE)
# The comment that makes an `Example*` a test `go test` runs.
_OUTPUT_COMMENT = re.compile(r"^[ \t]*//[ \t]*(?:unordered output|output):",
                             re.IGNORECASE | re.MULTILINE)
# The end of a top-level function body.
_BODY_END = re.compile(r"^}", re.MULTILINE)
# The prefixes `go test` runs a top-level function under.
_TEST_PREFIXES = ("Test", "Fuzz", "Example")
# Where a tier is declared, named by the refusal of a tier no module declares.
_TIER_DECLARATION_LINE = "`//go:build <target>` in a `_test.go` file that declares a test"


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
    fleet's one resolver (`resolve_base_url` in `_crucible_board.py`), which
    refuses when no file declares a board."""
    return _axi().resolve_base_url()


def _request(method, path, payload=None, timeout=None):
    """JSON request to Crucible through the fleet's one transport,
    `_crucible_axi.http_request`. Returns parsed JSON, or {ok:False,error}."""
    return _axi().http_request(_base_url(), method, path, payload, timeout)


def _post(path, payload, timeout=None):
    return _request("POST", path, payload, timeout=timeout)


def _get(path, timeout=None):
    # The read path is bounded by a SHORT hook-safe timeout so an unreachable
    # board can't hang a session-start hook forever.
    # The bound is the `read_timeout_seconds` setting, read at each call; an
    # explicit `timeout` wins.
    if timeout is None:
        timeout = _axi().SETTINGS.read_timeout_seconds
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
        base_url=_base_url)


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
    the test compile (`_check_command`) instead, then the same compile under
    `-tags <tier>` for each tier the module declares by build tag. Every
    compile runs, even after one fails. With `--agent` the failing compiles'
    output, stdout and stderr in the order go printed them, is filed as ONE
    compile run of format `go`, a line an earlier compile already printed
    dropped (`_merged_diagnostics`); a clean check files nothing.

    Refused before go compiles anything: first a run the board would file
    under no cycle while one is active (before the toolchain is touched, as
    the run verbs refuse it), then a Go below the floor, a module that cannot
    be found, and with `--tests` a missing no-op for `-exec`. One envelope on
    every path; the exit is go's own on a failing compile."""
    verb = "check"
    agent = args.agent
    project_dir = _resolve_project_dir(args.project_dir)
    _refuse_unattributed(args, project_dir, agent)
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
    commands = [cmd]
    if args.tests:
        commands += _tier_check_commands(cmd, project_dir, agent, module, warnings)
    exit_code, failed = 0, []
    for each in commands:
        print(f"[crucible] running: {' '.join(each)} (in {module})", file=sys.stderr)
        result = subprocess.run(each, cwd=module, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, check=False)
        print(f"[crucible] {' '.join(each[:2])} exit={result.returncode}",
              file=sys.stderr)
        if result.returncode != 0:
            exit_code = exit_code or result.returncode
            failed.append(result.stdout)
    ok = exit_code == 0
    if not ok:
        output = _merged_diagnostics(failed) if len(commands) > 1 else failed[0]
        sys.stderr.write(output)
        if agent:
            _ingest_go_compile(project_dir, agent, output, cycle)
    _emit_axi(verb, ok, {"exit": exit_code, "help": _axi().HELP_STEPS["check"]},
              _axi_context(project_dir, agent_id=agent), warnings,
              f"check: ok={ok} exit={exit_code}")
    return exit_code


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


def _tier_check_commands(cmd, project_dir, agent, module, warnings):
    """The test compile `cmd` under `-tags <tier>`, once for each tier
    `module` declares by build tag. When `go list` cannot read the
    declaration, a warning says so and no tier is compiled: the untagged
    compile still runs and reports what fails."""
    try:
        plans = _declared_tier_plans(project_dir, agent, [module])
    except _axi().DeclarationRefused as refused:
        # The untagged compile does run: the tier verbs' "nothing was run"
        # is not this warning's to say.
        cause = refused.detail.removesuffix(_GO_LIST_REFUSED_SUFFIX)
        warnings.append({"code": "tier-declaration-unreadable",
                         "detail": (f"no declared tier's test files were "
                                    f"compiled, only the untagged ones: "
                                    f"{cause}")})
        return []
    return [[*cmd[:2], "-tags", plan.tier, *cmd[2:]] for plan in plans]


def _merged_diagnostics(outputs):
    """(PURE) The failing compiles' `outputs` as one, in order, each line
    with its tab-indented continuation lines kept once: an error every build
    compiles (an untagged test file's) is printed by each build, and filed
    once."""
    seen, merged = set(), []
    for output in outputs:
        blocks = []
        for line in output.splitlines(keepends=True):
            if blocks and line.startswith("\t"):
                blocks[-1] += line
            else:
                blocks.append(line)
        for block in blocks:
            key = block.rstrip("\n")
            if key in seen:
                continue
            seen.add(key)
            merged.append(block if block.endswith("\n") else block + "\n")
    return "".join(merged)


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
    """The full suite, into ONE streamed run filed under `regression`: the
    untagged tests of every module under the project dir, then each declared
    tier's tests (`e2e` included), each tier invoked as its tier verb invokes
    it. With --coverage, every invocation's profile is merged into one."""
    verb = "regression"
    found = _gate_modules(verb, args)
    if isinstance(found, int):
        return found
    project_dir, agent, modules = found
    plans = _declared_tier_plans(project_dir, agent, modules)
    if not plans:
        return _gated_go_run(verb, args, project_dir, agent, modules, tier=verb)
    clashing = next((plan for plan in plans if plan.clashes), None)
    plan = _TierPlan(
        verb, project_dir, agent, modules,
        [[module, ["go", "test", "-json", "./..."]] for module in modules]
        + [invocation for tier_plan in plans for invocation in tier_plan.invocations],
        sum(tier_plan.total for tier_plan in plans), [], listed=modules)
    return _gated_go_run(verb, args, project_dir, agent, modules, plan=plan,
                         clashing=clashing)


def cmd_pre_merge_gate(args):
    """ORCHESTRATOR pre-merge gate, its outcome recorded as the gate's
    milestone. It composes the declared suites through the shared
    `gate_regression`: `untagged` is the whole run, the untagged tests of
    every module filed under `regression`; each declared tier runs as a suite
    of its own, under its tier; `e2e` is listed and excluded. A project that
    declares no tier has no suite, so its gate is the untagged run alone. A
    gate scoped to named suites that cannot run as asked is refused before
    anything else."""
    _axi().refuse_unrunnable_scoped_gate(
        args, surface=_TIER_DECLARATION_SURFACE, stack=_STACK, get=_get,
        project_key=lambda: _project_key(_resolve_project_dir(args.project_dir)))
    verb = "pre-merge-gate"
    found = _gate_modules(verb, args)
    if isinstance(found, int):
        return found
    project_dir, agent, modules = found
    # The board's codec health is read before the lint stage, as the rust gate
    # reads it: a gate the board cannot file runs no linter and posts nothing.
    refused = _codec_refusal(verb, args, project_dir, agent, _get("/api/v2/health"))
    if refused is not None:
        return refused
    # The lint stage comes next: a failing linter stops the gate here.
    stopped = _axi().gate_lint_stage(args, project_dir, _ops(), stack=_STACK,
                                     agent_id=agent, verb=verb,
                                     default=_go_vet_default(modules))
    if stopped is not None:
        return stopped

    def whole_suite():
        return _gated_go_run(verb, args, project_dir, agent, modules,
                             tier="regression")

    return _axi().gate_regression(
        args, surface=_TIER_DECLARATION_SURFACE, stack=_STACK, verb=verb,
        whole_suite=whole_suite, whole_suite_alone=whole_suite, dispatch=None,
        run_suite=lambda suite: _axi().declared_tier_run(
            suite.tier, (), _TIER_DECLARATION_SURFACE)(args),
        whole_framework=GO_TEST_CODEC,
        context=_axi_context(project_dir, agent_id=agent),
        crucible_url=_base_url)


def _gate_modules(verb, args):
    """`(project dir, agent, modules)` of a run over every module under the
    project dir, or the exit code of its refusal: a run the board would file
    under no cycle, no Go or a Go below the floor, no module. `go test ./...`
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
        return _refuse(verb, project_dir, agent, *_no_module_refusal(project_dir))
    return project_dir, agent, modules


def _no_module_refusal(project_dir):
    """`(error, help)` for a project dir under which no module is found."""
    return ((f"no go module was found: no go.mod under the project dir "
             f"{project_dir} (outside {', '.join(_SKIPPED_MODULE_DIRS)} "
             f"and hidden dirs); nothing was run"),
            [("run the gate from the project dir that holds the go modules "
              "(--project-dir <dir>)")])


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


def _gated_go_run(verb, args, project_dir, agent, modules, plan=None,
                  tier=None, clashing=None):
    """The board check and the gated-identity bracket around `_go_test_run`.
    A tier's `plan` (`_TierPlan`), or the `clashing` plan of a tier the run
    holds, is then checked for a test it cannot run alone, before any run
    opens. `tier` is the tier a run without a plan is filed under."""
    health = _get("/api/v2/health")
    refused = _codec_refusal(verb, args, project_dir, agent, health)
    if refused is not None:
        return refused
    if clashing is None and plan is not None and plan.clashes:
        clashing = plan
    if clashing is not None:
        return _refuse(verb, project_dir, agent, *_clash_refusal(clashing))
    with _axi().gated_run(project_dir, agent, getattr(args, "cycle", None),
                          f"gated {verb} run starting",
                          open_fn=_open_gate_identity,
                          close_fn=_close_gate_identity) as identity:
        return _go_test_run(verb, args, project_dir, agent, modules, health,
                            plan, tier, identity)


def _codec_refusal(verb, args, project_dir, agent, health):
    """The exit of a run refused because the board whose health is `health`
    cannot decode `go test -json` (or, with --coverage, the go coverage
    profile), after its one refusal envelope; else None."""
    coverage_codec = GO_COVERAGE_CODEC if getattr(args, "coverage", False) else None
    refused = _axi()._ingest_health_refusal(health, GO_TEST_CODEC, coverage_codec)
    if not refused:
        return None
    codecs = " and ".join(f"`{name}`" for name in (GO_TEST_CODEC, coverage_codec)
                          if name)
    return _refuse(verb, project_dir, agent, refused,
                   [f"point the project at a board that decodes {codecs}"])


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


def _coverage_profiles(own_dir, count):
    """`count` coverprofile paths (one per module or invocation), in the
    run's own reports dir, each removed first so a profile go did not write
    is never a stale one."""
    profiles = [os.path.join(own_dir, f"go-coverprofile-{index}.out")
                for index in range(count)]
    for profile in profiles:
        if os.path.exists(profile):
            os.remove(profile)
    return profiles


def _written_profiles(labels, profiles):
    """`(paths, warnings)`: every profile when go wrote them all; otherwise
    no path and one warning naming each module (or invocation, by `labels`)
    whose profile was not written, so a run never carries a partial total."""
    unwritten = [label for label, profile in zip(labels, profiles, strict=True)
                 if not os.path.isfile(profile)]
    if not unwritten:
        return list(profiles), []
    return [], [_axi().coverage_not_measured_warning(
        f"go wrote no coverprofile for the module(s) {', '.join(unwritten)}")]


def _with_coverprofile(invocations, profiles):
    """(PURE) `invocations` (`[cwd, argv]`), each writing its coverprofile
    to its own path of `profiles`, the flag placed before the package."""
    return [[cwd, [*argv[:-1], f"-coverprofile={profile}", argv[-1]]]
            for (cwd, argv), profile in zip(invocations, profiles, strict=True)]


def _merged_profile(texts):
    """(PURE) One coverprofile of several: the first `mode:` line once, then
    each block once, in the order first met. A block's count is the sum of
    its counts (`mode: set`: 1 when any covered it), so a block is covered
    when any profile covered it and no statement is counted twice."""
    mode, counts = None, {}
    for text in texts:
        lines = text.splitlines()
        if not lines:
            continue
        if mode is None:
            mode = lines[0]
        for line in lines[1:]:
            if not line.strip():
                continue
            block, count = line.rsplit(" ", 1)
            counts[block] = counts.get(block, 0) + int(count)
    if mode is None:
        return ""
    if mode.split(":", 1)[-1].strip() == "set":
        counts = {block: min(count, 1) for block, count in counts.items()}
    return "\n".join([mode, *(f"{block} {count}" for block, count in counts.items())]) + "\n"


def _merged_coverage(paths, warnings):
    """The one coverprofile text merged from `paths`, or None (a warning
    added to `warnings`) when one cannot be read."""
    texts = []
    for path in paths:
        try:
            with open(path, encoding="utf-8") as fh:
                texts.append(fh.read())
        except OSError as error:
            warnings.append(_axi().coverage_not_measured_warning(
                f"the coverprofile {path} could not be read ({error})"))
            return None
    return _merged_profile(texts)


def _coverage_post(text):
    """`_post`, with the run's close carrying `text` as its one
    `go-coverprofile`."""
    def post(path, payload, timeout=None):
        if path == _axi().INGEST_RUNS_PATH:
            payload = {**payload, "coverage": {"codec": GO_COVERAGE_CODEC,
                                               "data": [text]}}
        return _post(path, payload, timeout=timeout)
    return post


def _go_test_run(verb, args, project_dir, agent, modules, health, plan=None,
                 tier=None, identity=None):
    """List, open, run with the stream relayed, close: the body of a run
    once nothing refuses it. Returns the verb's exit code.

    A tier's `plan` (`_TierPlan`) replaces the list and the `./...` run: its
    test count is the start total (plus the list of its `listed` modules),
    its invocations are the run, and its tier rides the run's start and its
    close. Without a plan, `tier` (None: no tier stated) rides them. A
    `regression` run's coverage is every profile merged into one. The run's
    in-flight ticks count its stream against the listed `total`, and are
    observed by the gated bracket's `identity` (None: no bracket)."""
    key = _project_key(project_dir)
    release = getattr(args, "release", None)
    run = getattr(args, "run", None)
    tier = plan.tier if plan is not None else tier
    warnings = list(_axi().preflight_cycle_warnings(
        _get, key, agent, cycle_id=getattr(args, "cycle", None), context=None,
        release=release))
    if plan is not None:
        total = plan.total
        if plan.listed:
            totals = [_listed_total(module, None, warnings) for module in plan.listed]
            listed = [count for count in totals if count is not None]
            total = total + sum(listed) if len(listed) == len(totals) else None
    else:
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
                                     tier=tier, framework=GO_TEST_CODEC,
                                     release=release)
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
    covered = plan.invocations if plan is not None else modules
    profiles = _coverage_profiles(own_dir, len(covered)) if coverage else None
    if plan is not None:
        if profiles:
            plan = plan._replace(invocations=_with_coverprofile(plan.invocations,
                                                                profiles))
        run_cmd, run_cwd = _tier_runner_command(plan, own_dir, project_dir)
        running = ("go test -json ./..., then each declared tier's tests"
                   if plan.listed else f"go test -json -tags {tier}")
    else:
        run_cmd, run_cwd = _runner_command(modules, run, project_dir, profiles)
        running = "go test -json ./..."
    relay = None
    # The child that runs the tests, bracketed: a `unit` run that spends its
    # wall clock waiting says so in its own envelope. Every other tier runs
    # this same body and is left alone, because the shared check is scoped to
    # `unit` by the tier it is handed.
    try:
        with _axi().ChildRunTiming() as timing, _axi().abandon_trap(run_id):
            relay, _narrator = _axi().start_stream_relay(
                _post, _axi().narration_poster(_post, key, agent, identity), key, agent,
                run_id, stream_path, GO_TEST_CODEC, _axi()._ingest_body_limit(health),
                listed_total=total)
            print(f"[crucible] running: {running} (in {', '.join(modules)})",
                  file=sys.stderr)
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
    close_post = _post
    if coverage:
        labels = (modules if plan is None
                  else [f"{argv[-1]} in {cwd}" for cwd, argv in plan.invocations])
        coverage_paths, missing = _written_profiles(labels, profiles)
        warnings += missing
        if coverage_paths and tier == "regression":
            merged = _merged_coverage(coverage_paths, warnings)
            coverage_paths = []
            if merged is not None:
                close_post = _coverage_post(merged)
    resp = _axi().close_stream(close_post, stack=_STACK, project_key=key, agent_id=agent,
                               run_id=run_id, codec=GO_TEST_CODEC,
                               raw=result.stdout or None, runner_exit=runner_exit,
                               coverage_codec=GO_COVERAGE_CODEC if coverage_paths else None,
                               coverage_paths=coverage_paths, tier=tier,
                               framework=GO_TEST_CODEC, release=release)
    exit_code = _axi().verb_exit(runner_exit, resp)
    if not resp.get("ok"):
        warnings.append(_axi().ingest_failed_warning(verb, _base_url()))
    warnings += _axi().unit_run_wall_vs_cpu_warnings(tier, _STACK, timing)
    _axi().emit_run_axi(
        verb, resp,
        _axi_context(project_dir, agent_id=agent,
                     cycle_id=_axi().echoed_cycle_id(resp)),
        _emit_axi,
        help_steps=_axi().run_help(verb, exit_code == 0,
                                   _axi().filed_run(resp).get("failed"), _base_url()),
        warnings=warnings, fields={}, coverage=True)
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


# ── the tier verbs: a tier is declared by build tag ─────────────────────────


# What a tier run is, once read: the `tier`, the declaring `modules`, the
# `invocations` (`[cwd, argv]`, in order), the `total` of the tier's tests and
# the `clashes` (`(package, test)`) that cannot be run alone; `project_dir`
# and `agent` the run is made in and filed under; the `listed` modules whose
# untagged list adds to the start total (a `regression` run's).
_TierPlan = collections.namedtuple(
    "_TierPlan", ("tier", "project_dir", "agent", "modules", "invocations",
                  "total", "clashes", "listed"), defaults=((),))


def _is_test_name(name, prefix):
    """(PURE) Whether `go test` takes `name` as a `prefix` function: the
    prefix alone, or the prefix followed by anything but a lower-case letter."""
    return name.startswith(prefix) and (len(name) == len(prefix)
                                        or not name[len(prefix)].islower())


def _declared_tests(source):
    """(PURE) The tests a `_test.go` file's `source` declares, as `go test`
    counts them: top-level `Test*` and `Fuzz*` functions, and `Example*`
    functions whose body carries an output comment. Never a benchmark, never
    `TestMain`."""
    names = []
    for found in _DECLARED_FUNC.finditer(source):
        name = found.group(1)
        prefix = next((p for p in _TEST_PREFIXES if _is_test_name(name, p)), None)
        if prefix is None or name == "TestMain":
            continue
        if prefix == "Example":
            end = _BODY_END.search(source, found.end())
            body = source[found.end():end.start() if end else len(source)]
            if not _OUTPUT_COMMENT.search(body):
                continue
        names.append(name)
    return names


def _file_tests(package_dir, name):
    """The tests the test file `name` in `package_dir` declares."""
    with open(os.path.join(package_dir, name), encoding="utf-8") as fh:
        return _declared_tests(fh.read())


# What a tier verb's refusal adds to a `go list` failure: the verb ran nothing.
_GO_LIST_REFUSED_SUFFIX = "; the tier's declaration could not be read, so nothing was run"


def _listed_test_files(module, tags):
    """`{dir: (import path, internal test files, external test files)}` for
    every package of `module`, as `go list` names them under `tags` (None:
    untagged). A `go list` that fails is a hard stop: nothing is run."""
    cmd = ["go", "list", *(["-tags", tags] if tags else []),
           "-json=ImportPath,Dir,TestGoFiles,XTestGoFiles", "./..."]
    ran = subprocess.run(cmd, cwd=module, capture_output=True, text=True,
                         check=False)
    if ran.returncode != 0:
        said = (ran.stderr or ran.stdout or "").strip().splitlines()
        raise _axi().DeclarationRefused(
            f"`{' '.join(cmd)}` failed in {module} (exit {ran.returncode})"
            + (f": {said[-1]}" if said else "")
            + _GO_LIST_REFUSED_SUFFIX,
            ["fix what `go list` names, then re-run the verb"])
    packages = {}
    decoder, text, at = json.JSONDecoder(), ran.stdout, 0
    while True:
        while at < len(text) and text[at].isspace():
            at += 1
        if at >= len(text):
            return packages
        package, at = decoder.raw_decode(text, at)
        packages[package["Dir"]] = (package["ImportPath"],
                                    set(package.get("TestGoFiles") or ()),
                                    set(package.get("XTestGoFiles") or ()))


def _run_patterns(names):
    """(PURE) The `-run` values selecting exactly `names`, split so none
    exceeds `_RUN_ARG_BUDGET` bytes; `^$` alone when there is no name."""
    if not names:
        return ["^$"]
    chunks, current, size = [], [], len("^()$")
    for name in names:
        cost = len(name.encode()) + 1
        if current and size + cost > _RUN_ARG_BUDGET:
            chunks.append(current)
            current, size = [], len("^()$")
        current.append(name)
        size += cost
    chunks.append(current)
    return [f"^({'|'.join(chunk)})$" for chunk in chunks]


def _module_tier(module, tier, untagged=None):
    """`(test count, invocations, clashes)` of `tier` in `module`.

    A package's tier files are the test files the tagged `go list` names and
    the untagged one does not (`untagged`: that untagged list, when already
    read); a tier test also declared in a test file both builds compile, in
    the same package dir, is a clash."""
    if untagged is None:
        untagged = _listed_test_files(module, None)
    count, invocations, clashes = 0, [], []
    for package_dir, (path, internal, external) in sorted(
            _listed_test_files(module, tier).items()):
        _path, base_internal, base_external = untagged.get(
            package_dir, (path, set(), set()))
        added = sorted((internal - base_internal) | (external - base_external))
        if not added:
            continue
        # Internal and external test packages may each declare the same name.
        tests = {(kind, test)
                 for kind, files in (("internal", internal - base_internal),
                                     ("external", external - base_external))
                 for name in files for test in _file_tests(package_dir, name)}
        shared = {test for name in (internal & base_internal) | (external & base_external)
                  for test in _file_tests(package_dir, name)}
        names = sorted({test for _kind, test in tests})
        clashes += [(path, test) for test in names if test in shared]
        count += len(tests)
        invocations += [[module, ["go", "test", "-json", "-tags", tier, "-run",
                                  pattern, path]]
                        for pattern in _run_patterns(names)]
    return count, invocations, clashes


def _tier_modules(args, project_dir):
    """The modules a tier verb reads: the one --module-dir names, else every
    module under the project dir. `GO_CRUCIBLE_MODULE_DIR` and crucible.toml
    do not narrow it. None found is a hard stop."""
    named = getattr(args, "module_dir", None)
    if named:
        module, why = _named_module("--module-dir", named, project_dir)
        if module is None:
            raise _axi().DeclarationRefused(f"{why}; nothing was run",
                                            [_MODULE_DECLARATION_HELP])
        return [module]
    modules = _discover_modules(project_dir)
    if not modules:
        raise _axi().DeclarationRefused(*_no_module_refusal(project_dir))
    return modules


def _read_declared_build_tag(args, tier):
    """Go's READ of a tier: the `_TierPlan` of every module that declares
    it, or None when none does.

    Refused first, as hard stops and in this order, before `go list` probes
    the declaration: a run the board would file under no cycle, no Go or a Go
    below the floor, no module. No `go test` runs here."""
    agent = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    _refuse_unattributed(args, project_dir, agent)
    refused = _toolchain_refusal()
    if refused:
        raise _axi().DeclarationRefused(*refused)
    return _tier_plan(tier, project_dir, agent, _tier_modules(args, project_dir))


def _tier_plan(tier, project_dir, agent, modules, untagged=None):
    """The `_TierPlan` of `tier` over the `modules` that declare it, or None
    when none does. `untagged` maps a module to its untagged `go list`, when
    already read. `go list` runs; no `go test` does."""
    declaring, invocations, clashes, total = [], [], [], 0
    for module in modules:
        count, module_invocations, module_clashes = _module_tier(
            module, tier, (untagged or {}).get(module))
        if not count:
            continue
        declaring.append(module)
        invocations += module_invocations
        clashes += module_clashes
        total += count
    if not declaring:
        return None
    return _TierPlan(tier, project_dir, agent, declaring, invocations, total, clashes)


def _declared_tier_plans(project_dir, agent, modules):
    """The `_TierPlan` of every tier of the vocabulary (but `regression`)
    some module of `modules` declares, in the vocabulary's order."""
    untagged = {module: _listed_test_files(module, None) for module in modules}
    plans = (_tier_plan(tier, project_dir, agent, modules, untagged)
             for tier in _axi().TIER_MEANINGS if tier != "regression")
    return [plan for plan in plans if plan is not None]


def _read_declared_tiers(args, _surface):
    """Go's ENUMERATION of the gate's suites: `untagged`, the whole run's
    (the untagged tests of every module), then each declared tier, under a
    framework of its own so the gate runs it as a suite of its own. None when
    no module declares a tier. No Go, a Go below the floor, or no module is a
    hard stop, never a project that declares nothing."""
    refused = _toolchain_refusal()
    if refused:
        raise _axi().DeclarationRefused(*refused)
    project_dir = _resolve_project_dir(args.project_dir)
    plans = _declared_tier_plans(project_dir, None, _tier_modules(args, project_dir))
    if not plans:
        return ()
    return (("untagged", None, GO_TEST_CODEC),
            *((plan.tier, None, f"{GO_TEST_CODEC} -tags {plan.tier}") for plan in plans))


def _run_declared_build_tag(args, tier, plan):
    """Go's RUN of a tier: the board check, the clash check, then every
    invocation of `plan` into ONE run filed under the tier."""
    return _gated_go_run(tier, args, plan.project_dir, plan.agent, plan.modules,
                         plan=plan)


def _clash_refusal(plan):
    """`(error, help)` naming each tier test of `plan` that cannot be run
    alone."""
    named = "; ".join(f"{test} in package {package}" for package, test in plan.clashes)
    return ((f"the {plan.tier} tier cannot be run: {named} is also declared in "
             f"a test file both the tagged and the untagged build compile, so "
             f"-run would run the untagged one too; nothing was run"),
            [(f"rename one of the two, or constrain the untagged file with "
              f"`//go:build !{plan.tier}`")])


def _tier_runner_command(plan, own_dir, project_dir):
    """`(cmd, cwd)` running the plan's invocations: the one invocation
    directly, or each in turn through `_EACH_INVOCATION_RUNNER`, the list in
    a file of the run's reports dir."""
    if len(plan.invocations) == 1:
        cwd, argv = plan.invocations[0]
        return argv, cwd
    path = os.path.join(own_dir, _INVOCATIONS_FILE)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(plan.invocations, fh)
    return [sys.executable, "-c", _EACH_INVOCATION_RUNNER, path], project_dir


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
    """Close the resolved OPEN plan and post the cr-merged milestone. The
    gate's declaration surface is handed on, so a red declared suite is
    offered a gate scoped to it. Delegates to the shared implementation."""
    return _axi().cmd_cr_close(args, _resolve_project_dir(args.project_dir), _ops(),
                               surface=_TIER_DECLARATION_SURFACE, stack=_STACK)


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


def cmd_release_notes(args):
    """Draft one release's CHANGELOG section. Delegates to the shared implementation."""
    return _axi().cmd_release_notes(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_runs(args):
    """List a cycle's or a release's stored runs. Delegates to the shared implementation."""
    return _axi().cmd_runs(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_run(args):
    """Show one stored run. Delegates to the shared implementation."""
    return _axi().cmd_run(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_project_meta(args):
    """A project's metadata map, read or written. Delegates to the shared implementation."""
    return _axi().cmd_project_meta(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_lint(args):
    """Run the project's declared linter, else `go vet ./...` in each module
    under the project dir, and, with --agent, file it as one lint record.
    Delegates to the shared lint runner."""
    project_dir = _resolve_project_dir(args.project_dir)
    return _axi().cmd_lint(args, project_dir, _ops(), stack=_STACK,
                           default=_go_vet_default(_discover_modules(project_dir)))


def _go_vet_default(modules):
    """The go default linter: `go vet ./...` in each of `modules`, in order."""
    return _axi().lint_default(("go", "vet", "./..."), "go vet", run_dirs=modules)


def cmd_project_create(args):
    """Create this project on the board, or find it, by its token, under
    `--project-dir` made absolute. Delegates to the shared implementation."""
    return _axi().cmd_project_create(args, os.path.abspath(args.project_dir), _ops())


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
                        "-count=1 -vet=off -run '^$' with a no-op -exec), then "
                        "again under -tags <tier> for each tier the module "
                        "declares: no test runs and no vet check runs. Every "
                        "failing compile is filed as one compile run, each "
                        "error once.")
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


def _add_run_args(p):
    """`--agent`, `--log` and `--reports`, as every suite-wide run verb
    takes them."""
    p.add_argument("--agent",
                   help="Registered agent id to file the run under — REQUIRED, "
                        "enforced at RUNTIME.")
    p.add_argument("--log",
                   help="Write the run's stderr to this file in addition to "
                        "streaming it.")
    p.add_argument("--reports", help=_REPORTS_HELP)


def _add_regression_coverage_arg(p):
    p.add_argument("--coverage", action="store_true",
                   help="Write each invocation's coverprofile (go test "
                        "-coverprofile) in the run's reports dir, merge them "
                        "into one (a block covered when any covered it) and "
                        "send it with the run's close as go-coverprofile; a "
                        "profile that was not written leaves the run with no "
                        "coverage.")


def _add_declared_tier_args(p):
    """The flags a declared tier verb takes: the run's, and `--module-dir`."""
    _add_run_args(p)
    p.add_argument("--module-dir",
                   help="Run only this module, relative to the project dir "
                        "(default: every module under the project dir that "
                        "declares the tier). A module that does not declare "
                        "the tier is refused.")
    _add_gate_cycle_arg(p)
    _axi().add_run_release_arg(p)


# Go's declaration surface: a tier is declared by build tag, read by
# `go list -tags <tier>` and the tests its files declare.
_TIER_DECLARATION_SURFACE = _axi().DeclaredTierSurface(
    target="<tier>",
    names=_TIER_DECLARATION_LINE,
    read=_read_declared_build_tag,
    run=_run_declared_build_tag,
    add_args=(_add_declared_tier_args,),
    suites=_read_declared_tiers,
)


# What a declared tier verb does, in go's own words: the line after the shared
# meaning in its help.
_DECLARED_TIER_VERB_RUNS = (
    "A tier is declared by build tag: `//go:build {tier}` in a `_test.go` file "
    "that declares a test. Runs only the tests that tag adds, in every module "
    "that declares it (or the one --module-dir names), into one run filed "
    "under its tier and streamed to the board. A tier no module declares is "
    "refused, and so is a tier test also declared in a file the untagged "
    "build compiles, which -run cannot select alone.")


def _add_tier_verbs(sub):
    """The six tier verbs, through the shared registration: `regression`
    wired with its own flags, the other five declared by build tag, each
    one's help line then saying so in go's own words."""
    tier_verb = _axi().TierVerb
    _axi().add_tier_verbs(
        sub,
        # pi-lens-ignore: C408 — the keyword form keeps the tier names out of a string-keyed literal, so the shared module holds the one copy of the tier vocabulary
        dict(regression=tier_verb(  # noqa: C408
            cmd_regression,
            "Runs `go test -json ./...` in every module under the project dir "
            "(skipping vendor, testdata, node_modules and hidden dirs), then "
            "each declared tier's tests, into one run filed under regression "
            "and streamed to the board; --coverage adds one coverprofile, "
            "merged from every invocation's.",
            (_add_run_args, _add_regression_coverage_arg, _add_gate_cycle_arg,
             _axi().add_run_release_arg))),
        declares=_TIER_DECLARATION_SURFACE,
        add_args=(_add_project_dir_arg,))
    meanings = _axi().TIER_MEANINGS
    for action in sub._choices_actions:
        if action.dest in meanings and action.dest != "regression":
            action.help = _axi().tier_verb_help(
                action.dest, meanings[action.dest],
                tier_verb(None, _DECLARED_TIER_VERB_RUNS.format(tier=action.dest)))


def _add_gate_verbs(sub):
    """`pre-merge-gate`: the untagged run over every module under the project
    dir plus each declared tier as a suite of its own, its outcome the gate's
    milestone."""
    g = sub.add_parser("pre-merge-gate",
                       help=("ORCHESTRATOR pre-merge gate: fail-fast lint → "
                             "the untagged run "
                             "over every module, filed under regression, and "
                             "each declared tier as a suite of its own, its "
                             "outcome posted as the pre-merge-gate "
                             "milestone."),
                       description=("The gate's stages, in order: fail-fast lint → "
                                    "the untagged run over every module, filed under "
                                    "regression, and each declared tier as a suite of "
                                    "its own. The lint stage runs the project's [lint] "
                                    "table, else go's default, `go vet ./...` in each "
                                    "module, joined into one lint record; a failing "
                                    "lint stops the gate before the tests. --skip-lint "
                                    "skips the lint stage."))
    _add_run_args(g)
    _axi().add_skip_lint_arg(g)
    _add_gate_cycle_arg(g)
    _axi().add_run_release_arg(g)
    _axi().add_gate_suites_arg(g)
    _add_project_dir_arg(g)
    g.set_defaults(func=cmd_pre_merge_gate)


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
        help='Legacy comma-split form, REFUSED for filing: a filed '
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

    _axi().add_lint_verb(sub, cmd_lint, add_args=(_add_project_dir_arg,))

    pcv = sub.add_parser("project-create",
                         help="Create this project on the board, or find it, by its "
                              "token; print its key (`--write-env` writes it to .env).")
    _axi().add_project_create_args(pcv)
    pcv.set_defaults(func=cmd_project_create)

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
    _axi().add_release_notes_verb(sub, {"release-notes": cmd_release_notes},
                                  add_args=(_add_project_dir_arg,))
    _axi().add_queue_file_verb(sub, cmd_queue_file, add_args=(_add_project_dir_arg,))


def main():
    p = argparse.ArgumentParser(prog="go-crucible", description=_CLI_DESCRIPTION)
    # The subcommand is OPTIONAL: a bare invocation falls through to the live
    # dashboard, never argparse's required-subcommand error.
    sub = p.add_subparsers(dest="cmd", required=False)
    _add_lifecycle_verbs(sub)
    _add_plan_verbs(sub)
    _add_tier_verbs(sub)
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
    # `project-create` reads no key of its own: its hard stop or escaped
    # failure carries an empty context.
    project_key_fn = (None if args.cmd == _axi().PROJECT_CREATE_VERB else
                      lambda a: _project_key(_resolve_project_dir(getattr(a, "project_dir", None))))
    sys.exit(_axi().run_verb(
        args.func, args, project_key_fn,
        ops_fn=_ops,
        project_dir_fn=lambda a: _resolve_project_dir(getattr(a, "project_dir", None))))


if __name__ == "__main__":
    main()
