#!/usr/bin/env python3
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""EDA Crucible CLI — single entry point for orchestrator + eda-{red,green,fix,
verify} agent lifecycle ops AND for an electronics project's pytest gates,
each declared in the project's own `crucible.toml` and run in the project's
own interpreter.

This script is tool-specific (pytest over an EDA project's gates), not
project-specific — the project path is parameterizable.

Subcommands:
  register, unregister  Agent lifecycle.
  test                  --tests <path or node id> …: one pytest run with no
                        tier. Without --tests it is refused, naming the tier
                        verbs.
  unit, module, integration, e2e, bdd
                        The tier verbs. A tier is declared by its eda
                        entries: `[targets."<tier>"]` or
                        `[targets."<tier>/<label>"]` with framework =
                        "eda-pytest". A tier with no entry is refused.
  regression            Every eda entry's paths (`e2e` included), refused when
                        the project declares no eda entry.
  pre-merge-gate        The gate, through the shared composition: one suite
                        per eda entry, refused when the project declares no
                        eda entry.
  auto-ingest           Ingest only: an already-produced reports dir's JUnit
                        is sent to the board, framework eda-pytest.
  plan / cycle / status verbs, the roadmap verbs and `next`: the fleet's
                        shared implementations, one thin delegator each.

What a run verb does today:
  It resolves the project dir, its key, its declaration and its interpreter,
  probes that the interpreter imports pytest, and then answers ok:false
  saying the eda entries are not run by this build yet: nothing is run and
  nothing is opened on the board.

The project dir, in this order:
  --project-dir > $EDA_CRUCIBLE_PROJECT_DIR > the git repo of the working
  directory > the working directory. For a project whose eda work lives in a
  sub-directory (`hardware/`), that sub-directory is named explicitly.

The key:
  CRUCIBLE_PROJECT_KEY from <project-dir>/.env only, never a parent's.

The interpreter, in this order:
  --python > $EDA_CRUCIBLE_PYTHON > crucible.toml `[eda] python` (relative to
  the project dir) > <project-dir>/.venv/bin/python. With none it is refused,
  naming every candidate: the client's own interpreter is never used. The
  chosen interpreter must import pytest, probed headless
  (QT_QPA_PLATFORM=offscreen, no DISPLAY, no WAYLAND_DISPLAY).

The declaration (<project-dir>/crucible.toml):
  An eda entry is a `[targets."<key>"]` table whose framework is
  "eda-pytest"; its key is `<tier>` or `<tier>/<label>` (tier one of unit,
  module, integration, e2e, bdd; label non-empty), and its `paths` is a
  non-empty list of paths relative to the project dir, each optionally
  followed by `::<node id>`, whose file or directory exists. Any other field
  is ignored. An entry naming another stack's framework, or no framework
  (rust's), is skipped; a framework no stack reserves is refused. An absent
  file declares nothing; one that does not parse is refused.

Project + Crucible endpoint:
  Posts to the first `[client] url` declared by the project's crucible.toml,
  then the install's (with neither declaring one, a verb that must reach the
  board refuses). The client parses no test report.

Examples:
  eda-crucible.py register --agent <agentId> --role RED --cycle <cycleId>
  eda-crucible.py unit --agent <agentId> --project-dir hardware
  eda-crucible.py test --agent <agentId> --tests tests/unit/check_board.py
"""

# pi-lens-ignore: I001 — pi-lens lints with its own ruff configuration, which sets no target version, so ruff files `tomllib` as third-party whatever the declared floor
import argparse  # noqa: I001
import collections
import importlib.util
import os
import shutil
import subprocess
import sys
import tomllib

# The STACK this client's runs belong to — the name its sibling clients address
# it by (`eda-crucible.py`).
_STACK = "eda"
# The framework an eda entry declares, and every run this client files names.
EDA_FRAMEWORK = "eda-pytest"
# The board codec that decodes a pytest JUnit report.
JUNIT_CODEC = "junit"
# The client's own steering variables: its project dir and its interpreter.
_PROJECT_DIR_VAR = "EDA_CRUCIBLE_PROJECT_DIR"
_PYTHON_VAR = "EDA_CRUCIBLE_PYTHON"
# The table and field a project declares its interpreter in.
_EDA_TABLE = "eda"
_PYTHON_FIELD = "python"
# The project's own venv interpreter, relative to the project dir.
_VENV_PYTHON = os.path.join(".venv", "bin", "python")
# The frameworks other stacks reserve in the same `[targets.*]` table: an
# entry naming one is another stack's, skipped rather than refused.
_OTHER_STACKS_FRAMEWORKS = ("nextest", "surefire", "unittest", "pytest",
                            "bun-test", "vitest", "playwright", "playwright-bdd",
                            "go-test", "arduino-native")
# What separates an entry path from the pytest node id it names.
_NODE_ID_SEPARATOR = "::"
# The environment every child that runs project code gets: no display, and
# Qt told to draw offscreen, so no tool a gate drives can open a window.
_HEADLESS_SET = {"QT_QPA_PLATFORM": "offscreen"}
_HEADLESS_UNSET = ("DISPLAY", "WAYLAND_DISPLAY")


def _resolve_project_dir(arg_value):
    """Resolution order: --project-dir > $EDA_CRUCIBLE_PROJECT_DIR > git repo
    of CWD > CWD.

    No project is hardcoded. The `.env` holding CRUCIBLE_PROJECT_KEY must live
    at the resolved root. The root is BOUND into the shared module here, on
    the client's own boot path, so the project's `crucible.toml` beside that
    `.env` is the one its limits and board are read from."""
    if arg_value:
        root = arg_value
    elif (env_value := os.environ.get(_PROJECT_DIR_VAR)):
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
    # The read path is bounded by the `read_timeout_seconds` setting, read at
    # each call, so an unreachable board can't hang a session-start hook; an
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


# ── the declaration: the project's eda entries and its interpreter ──────────

#: One declared eda entry: its `[targets.*]` key, the key's tier and label
#: (None for a bare `<tier>` key) and its `paths`, as declared.
EdaEntry = collections.namedtuple("EdaEntry", ("key", "tier", "label", "paths"))

#: What a project's `crucible.toml` declares for this client: the file read,
#: its eda entries in key order, and its `[eda] python` resolved against the
#: project dir (None when it declares none).
EdaDeclaration = collections.namedtuple("EdaDeclaration",
                                        ("path", "entries", "python"))


def _entry_tiers():
    """The tiers an eda entry's key may name: the vocabulary's, `regression`
    excepted (a union of entries, never an entry)."""
    return tuple(tier for tier in _axi().TIER_MEANINGS if tier != "regression")


def _declaration_refused(table, field, path, why):
    """The shared `DeclarationRefused` hard stop naming the table, the field
    (when one is at fault) and the file."""
    named = f"{table} `{field}`" if field else table
    return _axi().DeclarationRefused(
        f"{named} in {path} {why}; nothing was run",
        [f"fix {table} in {path}, then re-run", "status"])


def _read_declaration(project_dir):
    """The project's `EdaDeclaration`, read from `<project-dir>/crucible.toml`.

    An absent file declares nothing. A file that does not parse, an entry at
    fault, or an `[eda] python` that is not an executable file raises the
    shared `DeclarationRefused` hard stop."""
    path = os.path.join(project_dir, "crucible.toml")
    try:
        with open(path, "rb") as handle:
            parsed = tomllib.load(handle)
    except FileNotFoundError:
        return EdaDeclaration(path, (), None)
    except (OSError, ValueError) as error:
        raise _axi().DeclarationRefused(
            f"the project's crucible.toml ({path}) does not parse ({error}), so "
            f"its eda entries cannot be read; nothing was run",
            [f"fix {path}, then re-run", "status"]) from error
    targets = parsed.get("targets")
    entries = []
    if isinstance(targets, dict):
        for key in sorted(targets):
            entry = _eda_entry(key, targets[key], project_dir, path)
            if entry is not None:
                entries.append(entry)
    return EdaDeclaration(path, tuple(entries),
                          _declared_python(parsed, project_dir, path))


def _eda_entry(key, entry, project_dir, path):
    """The `EdaEntry` under `[targets."<key>"]`, or None for another stack's
    entry (one with no framework, or a framework another stack reserves),
    decided on `framework` before any other field is checked."""
    table = f'[targets."{key}"]'
    framework = entry.get("framework") if isinstance(entry, dict) else None
    if framework is None or framework in _OTHER_STACKS_FRAMEWORKS:
        return None
    if framework != EDA_FRAMEWORK:
        raise _declaration_refused(
            table, "framework", path,
            f"declares framework = {framework!r}, which no stack reserves (an "
            f"eda entry declares framework = \"{EDA_FRAMEWORK}\")")
    tier, slash, label = key.partition("/")
    tiers = _entry_tiers()
    if tier not in tiers:
        raise _declaration_refused(
            table, None, path,
            f"names the tier {tier!r}, which is not one of {', '.join(tiers)}: "
            f"an eda entry's key is `<tier>` or `<tier>/<label>`")
    if slash and not label:
        raise _declaration_refused(
            table, None, path,
            "has an empty label: an eda entry's key is `<tier>` or "
            "`<tier>/<label>`, its label non-empty")
    paths = entry.get("paths")
    if (not isinstance(paths, list) or not paths
            or not all(isinstance(item, str) for item in paths)):
        raise _declaration_refused(
            table, "paths", path,
            f"is {paths!r}: an eda entry's paths is a non-empty list of "
            f"strings, each relative to the project dir")
    for item in paths:
        named = item.split(_NODE_ID_SEPARATOR, 1)[0]
        if not os.path.exists(os.path.join(project_dir, named)):
            raise _declaration_refused(
                table, "paths", path,
                f"names {item!r}, but {named!r} does not exist under the "
                f"project dir {project_dir}")
    return EdaEntry(key, tier, label or None, tuple(paths))


def _declared_python(parsed, project_dir, path):
    """`[eda] python` resolved against the project dir, or None when the
    project declares none. One that is not an executable file is refused."""
    if _EDA_TABLE not in parsed:
        return None
    table = parsed[_EDA_TABLE]
    named = f"[{_EDA_TABLE}]"
    if not isinstance(table, dict):
        raise _declaration_refused(named, None, path, "is not a table")
    if _PYTHON_FIELD not in table:
        return None
    value = table[_PYTHON_FIELD]
    if not isinstance(value, str) or not value:
        raise _declaration_refused(named, _PYTHON_FIELD, path,
                                   f"is {value!r}, not an interpreter's path")
    python = os.path.join(project_dir, value)
    if not (os.path.isfile(python) and os.access(python, os.X_OK)):
        raise _declaration_refused(
            named, _PYTHON_FIELD, path,
            f"names {value!r} ({python}), which is not an executable file")
    return python


def _declaration(args):
    """The project's declaration, once per invocation: resolved with the
    project dir and its key (a missing key refuses here, before anything is
    read or posted), then kept on `args`."""
    held = getattr(args, "eda_declaration", None)
    if held is None:
        project_dir = _resolve_project_dir(args.project_dir)
        _project_key(project_dir)
        held = _read_declaration(project_dir)
        args.eda_declaration = held
    return held


def _no_entry_refusal(declaration):
    """`(error, help)` for a project that declares no eda entry at all."""
    return ((f"{declaration.path} declares no eda entry, so there is nothing "
             f"to run; nothing was run"),
            [(f'declare one: [targets."<tier>"] (or [targets."<tier>/<label>"]) '
              f'with framework = "{EDA_FRAMEWORK}" and paths = ["<path>", …], '
              f"in {declaration.path}"),
             "status"])


# ── the interpreter: the project's, never this client's own ────────────────


def _headless_env():
    """This process's environment made headless for a child that runs
    project code: `QT_QPA_PLATFORM=offscreen`, no `DISPLAY`, no
    `WAYLAND_DISPLAY`."""
    env = dict(os.environ)
    env.update(_HEADLESS_SET)
    for name in _HEADLESS_UNSET:
        env.pop(name, None)
    return env


def _resolve_python(args, project_dir, declaration):
    """--python > $EDA_CRUCIBLE_PYTHON > `[eda] python` > the project's
    `.venv/bin/python`, or None when none of them names an interpreter. The
    client's own interpreter is never a candidate."""
    flag = getattr(args, "python", None)
    if flag:
        return os.path.abspath(flag)
    from_env = os.environ.get(_PYTHON_VAR)
    if from_env:
        return os.path.abspath(from_env)
    if declaration.python:
        return declaration.python
    venv = os.path.join(project_dir, _VENV_PYTHON)
    if os.path.exists(venv):
        return venv
    return None


def _interpreter_refusal(python, project_dir, declaration):
    """`(error, help)` when `python` cannot run the project's pytest — none
    resolved, it cannot import pytest, or its probe did not answer in time —
    else None. The probe runs headless, in the project dir."""
    if python is None:
        venv = os.path.join(project_dir, _VENV_PYTHON)
        return ((f"no interpreter resolves for this project: no --python was "
                 f"given, {_PYTHON_VAR} is unset, {declaration.path} declares "
                 f"no [{_EDA_TABLE}] {_PYTHON_FIELD}, and {venv} does not "
                 f"exist; this client never runs a project's tests in its own "
                 f"interpreter; nothing was run"),
                [f"name the project's interpreter with --python <path>, "
                 f"{_PYTHON_VAR}=<path> or [{_EDA_TABLE}] {_PYTHON_FIELD} = "
                 f"\"<path>\" in {declaration.path}, or create {venv}"])
    importable = _axi().pytest_importable(python, project_dir, env=_headless_env())
    if importable is None:
        return ((f"the interpreter {python} did not answer whether it can "
                 f"import pytest within {_axi().pytest_probe_timeout()}s; "
                 f"nothing was run"),
                ["check that interpreter, or name another with --python <path>"])
    if not importable:
        return ((f"the interpreter {python} cannot import pytest, which every "
                 f"eda run needs; nothing was run"),
                [f"install pytest into {python}, or name another interpreter "
                 f"with --python <path>"])
    return None


def _refuse(verb, project_dir, agent, error, help_steps, warnings=()):
    """ONE ok:false envelope for a run refused before anything ran; exit 1."""
    _emit_axi(verb, False, {"error": error, "help": list(help_steps)},
              _axi_context(project_dir, agent_id=agent), list(warnings),
              f"[crucible] ERROR: {error}")
    return 1


def _refuse_unattributed(args, project_dir, agent):
    """Refuse a run the board would file under no cycle (or while a cycle is
    active elsewhere) before an interpreter is spawned or anything runs."""
    _axi().refuse_unattributed_run(
        _get, _project_key(project_dir), agent,
        cycle_id=getattr(args, "cycle", None),
        release=getattr(args, "release", None), context=None)


def _resolved_run(verb, args, what):
    """The steps every run verb takes once its declaration is read: the
    unattributed-run refusal, then the interpreter and its pytest probe, each
    refused before anything is posted. `what` names what the run would cover.
    This build runs no eda entry: a resolved run is answered ok:false,
    nothing run and nothing opened on the board."""
    agent = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    declaration = _declaration(args)
    _refuse_unattributed(args, project_dir, agent)
    python = _resolve_python(args, project_dir, declaration)
    refused = _interpreter_refusal(python, project_dir, declaration)
    if refused is not None:
        return _refuse(verb, project_dir, agent, *refused)
    return _refuse(
        verb, project_dir, agent,
        (f"{what} resolved, and {python} imports pytest, but this build of the "
         f"eda client does not run eda entries yet; nothing was run"),
        ["re-run once the eda client runs its entries", "status"])


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
    """One pytest run over `--tests` (paths or node ids), filed under no
    tier. Without `--tests` it is refused, naming the tier verbs."""
    verb = "test"
    agent = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    _declaration(args)
    if not getattr(args, "tests", None):
        return _refuse(
            verb, project_dir, agent,
            "test runs the paths or node ids --tests names, and none was given; "
            "nothing was run",
            [f"name them: test --tests <path or node id> …, or run a tier verb "
             f"({', '.join(_entry_tiers())}, regression)"])
    return _resolved_run(verb, args, f"the selection {' '.join(args.tests)}")


def cmd_regression(args):
    """Every eda entry's paths (`e2e` included) as one run filed under
    `regression`; refused when the project declares no eda entry."""
    verb = "regression"
    agent = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    declaration = _declaration(args)
    if not declaration.entries:
        return _refuse(verb, project_dir, agent, *_no_entry_refusal(declaration))
    return _resolved_run(verb, args, _entries_named(declaration.entries))


def cmd_pre_merge_gate(args):
    """ORCHESTRATOR pre-merge gate: one suite per eda entry, after the shared
    refusal of a scoped gate that cannot run as asked; refused when the
    project declares no eda entry."""
    _axi().refuse_unrunnable_scoped_gate(
        args, surface=_TIER_DECLARATION_SURFACE, stack=_STACK, get=_get,
        project_key=lambda: _project_key(_resolve_project_dir(args.project_dir)))
    verb = "pre-merge-gate"
    agent = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    declaration = _declaration(args)
    if not declaration.entries:
        return _refuse(verb, project_dir, agent, *_no_entry_refusal(declaration))
    return _resolved_run(verb, args, _entries_named(declaration.entries))


def _entries_named(entries):
    """The eda entries `entries` as their declared tables."""
    return "the eda entries " + ", ".join(f'[targets."{e.key}"]' for e in entries)


def cmd_auto_ingest(args):
    """Ingest an already-produced reports dir: its JUnit reports are sent to
    the board for it to decode, framework eda-pytest, under no tier."""
    verb = "auto-ingest"
    project_dir = _resolve_project_dir(args.project_dir)
    reports_dir = _axi().run_reports_dir(project_dir, args.reports)
    junit_glob = _axi().JUNIT_REPORT_GLOB
    if not _axi().produced_junit(reports_dir):
        _emit_axi(verb, False,
                  {"help": _axi().no_report_help(verb, junit_glob)},
                  _axi_context(project_dir, agent_id=args.agent),
                  [_axi().no_report_warning(verb, junit_glob, 1, "")],
                  f"{verb}: ok=False — no {junit_glob} in {reports_dir}")
        return 1
    cycle_id = getattr(args, "cycle", None)
    preflight_warnings = _axi().preflight_cycle_warnings(
        _get, _project_key(project_dir), args.agent, cycle_id=cycle_id)
    resp = _axi().ingest_reports(
        _post, _get, stack=_STACK, project_key=_project_key(project_dir),
        agent_id=args.agent, codec=JUNIT_CODEC,
        report_paths=_axi().junit_report_paths(reports_dir),
        context=_axi().cycle_context(None, cycle_id), framework=EDA_FRAMEWORK)
    _axi().emit_run_axi(
        verb, resp,
        _axi_context(project_dir, agent_id=args.agent,
                     cycle_id=_axi().echoed_cycle_id(resp)),
        _emit_axi, warnings=preflight_warnings, fields={})
    return 0 if resp.get("ok") else 1


# ── the tier verbs' declaration surface ─────────────────────────────────────


def _read_declared_entries(args, target):
    """The eda entries whose key's tier is `target`, in key order (empty when
    the project declares none for it)."""
    return tuple(e for e in _declaration(args).entries if e.tier == target)


def _run_declared_entries(args, tier, entries):
    """A tier verb's run over its declared `entries`."""
    return _resolved_run(tier, args, _entries_named(entries))


def _read_declared_suites(args, _surface):
    """The gate's suites: one per eda entry, `(key, None, eda-pytest)`; the
    shared code reads each key's tier from its first segment."""
    return tuple((e.key, None, EDA_FRAMEWORK) for e in _declaration(args).entries)


def _runnable_tiers(args):
    """The tier verbs this client runs on this project: the tiers its eda
    entries declare, as far as the declaration was read."""
    held = getattr(args, "eda_declaration", None)
    entries = held.entries if held is not None else ()
    return sorted({e.tier for e in entries})


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
    "eda-crucible.py -- EDA Crucible CLI "
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
        help="Override project root (default: $EDA_CRUCIBLE_PROJECT_DIR, else the git "
             "repo containing the current directory). For an eda sub-project "
             "(e.g. hardware/) name it here. The .env at the project root must "
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
    "EDA Crucible CLI — one entry point for the orchestrator and for the "
    "eda-{red,green,fix,verify} agent lifecycle, and for an electronics "
    "project's pytest gates, declared as eda-pytest entries in its own "
    "crucible.toml.\n\n"
    "Tool-specific (pytest over EDA gates), never project-specific: the project "
    "path is parameterizable. Run `<verb> --help` for a verb's own flags.\n\n"
    "The interpreter is the project's: --python, else EDA_CRUCIBLE_PYTHON, else "
    "crucible.toml [eda] python, else <project-dir>/.venv/bin/python; with none "
    "the run is refused. It must import pytest.\n\n"
    + _axi().BOARD_CONFIGURATION_HELP
)


def _add_gate_cycle_arg(p):
    """Bind `--cycle` on a gated verb (delegates to the shared binding so the
    fleet documents it identically)."""
    return _axi().add_gate_cycle_arg(p)


def _add_run_args(p):
    """`--agent`, `--log` and `--reports`, as every run verb takes them."""
    p.add_argument("--agent",
                   help="Registered agent id to file the run under — REQUIRED, "
                        "enforced at RUNTIME.")
    p.add_argument("--log",
                   help="Write the run's stderr to this file in addition to "
                        "streaming it.")
    p.add_argument("--reports", help=_axi().REPORTS_HELP)


def _add_python_arg(p):
    p.add_argument("--python",
                   help="The project's interpreter, which must import pytest "
                        "(default: $EDA_CRUCIBLE_PYTHON, else crucible.toml "
                        "[eda] python, else <project-dir>/.venv/bin/python). "
                        "The client's own interpreter is never used.")


def _add_declared_tier_args(p):
    """The flags a declared tier verb takes."""
    _add_run_args(p)
    _add_python_arg(p)
    _add_gate_cycle_arg(p)
    _axi().add_run_release_arg(p)


def _add_lifecycle_verbs(sub):
    """`register`, `unregister`, `test` and `auto-ingest`."""
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
        help="One pytest run over --tests (paths or node ids), filed under no tier.")
    _add_run_args(t)
    t.add_argument("--tests", nargs="+",
                   help="The paths or pytest node ids to run, relative to the "
                        "project dir. Required: without it the run is refused.")
    _add_python_arg(t)
    _add_gate_cycle_arg(t)
    _axi().add_run_release_arg(t)
    _add_project_dir_arg(t)
    _axi().add_hermetic_arg(t)
    t.set_defaults(func=cmd_test)

    a = sub.add_parser("auto-ingest",
                       help="Ingest an already-produced reports dir's JUnit, "
                            "framework eda-pytest.")
    a.add_argument("--agent", required=True,
                   help="Agent id to ingest under — REQUIRED; it must already be "
                        "registered.")
    a.add_argument("--reports", help=_axi().REPORTS_HELP)
    _axi().add_filing_cycle_arg(a)
    _add_project_dir_arg(a)
    a.set_defaults(func=cmd_auto_ingest)


# The eda declaration surface: a tier is declared by its eda entries, each a
# `[targets."<tier>"]` or `[targets."<tier>/<label>"]` table.
_TIER_DECLARATION_SURFACE = _axi().DeclaredTierSurface(
    target="<tier>",
    names=(f'[targets."<target>"] (or [targets."<target>/<label>"]) with '
           f'framework = "{EDA_FRAMEWORK}" and paths = ["<path>", …] in the '
           f"project dir's crucible.toml"),
    read=_read_declared_entries,
    run=_run_declared_entries,
    add_args=(_add_declared_tier_args,),
    suites=_read_declared_suites,
    runnable=_runnable_tiers,
    labelled=True,
)


def _add_tier_verbs(sub):
    """The six tier verbs, through the shared registration: `regression`
    wired with its own flags, the other five declared by eda entries."""
    _axi().add_tier_verbs(
        sub,
        # pi-lens-ignore: C408 — the keyword form keeps the tier names out of a string-keyed literal, so the shared module holds the one copy of the tier vocabulary
        dict(regression=_axi().TierVerb(  # noqa: C408
            cmd_regression,
            "Every eda entry's paths (e2e included) as one pytest run filed "
            "under regression; refused when the project declares no eda entry.",
            (_add_run_args, _add_python_arg, _add_gate_cycle_arg,
             _axi().add_run_release_arg))),
        declares=_TIER_DECLARATION_SURFACE,
        add_args=(_add_project_dir_arg,))


def _add_gate_verbs(sub):
    """`pre-merge-gate`: one suite per eda entry, its outcome the gate's
    milestone."""
    g = sub.add_parser("pre-merge-gate",
                       help=("ORCHESTRATOR pre-merge gate: one suite per eda "
                             "entry (e2e entries listed and excluded), its "
                             "outcome posted as the pre-merge-gate milestone."))
    _add_run_args(g)
    _add_python_arg(g)
    _add_gate_cycle_arg(g)
    _axi().add_run_release_arg(g)
    _axi().add_gate_suites_arg(g)
    _add_project_dir_arg(g)
    _axi().add_hermetic_arg(g)
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
    p = argparse.ArgumentParser(prog="eda-crucible", description=_CLI_DESCRIPTION)
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
    # (an undeclared agent identity, a refused declaration, an undeclared
    # tier among them) into the ok:false envelope + a non-zero exit instead
    # of an unhandled traceback. `project-create` reads no key of its own:
    # its hard stop or escaped failure carries an empty context.
    project_key_fn = (None if args.cmd == _axi().PROJECT_CREATE_VERB else
                      lambda a: _project_key(_resolve_project_dir(getattr(a, "project_dir", None))))
    sys.exit(_axi().run_verb(
        args.func, args, project_key_fn,
        ops_fn=_ops,
        project_dir_fn=lambda a: _resolve_project_dir(getattr(a, "project_dir", None))))


if __name__ == "__main__":
    main()


