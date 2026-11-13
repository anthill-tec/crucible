"""The `lint` verb the client fleet shares: a project's declared linter (or its
stack's default) run in the project, and its output filed on the board's
compile route as a lint record.

The declaration is a `[lint]` table of `crucible.toml`, read through the one
configuration walk the core reads `[gate]` by: the project's own file first,
then the install's, the first file that parses winning. Its fields:

- `command`, a non-empty list of non-empty strings, required;
- `format`, the board's decoder for the output, optional;
- `name`, the linter's name, optional.

A malformed table is refused, naming its file, before anything runs. A
declared `command` replaces the stack's default (`lint_default`); with neither
the run is skipped (`skipped: not-declared`), never refused.

The marker -- the `lint` value posted, and the envelope's `linter` -- is the
declared `name`, else the declared `format`, else the basename of the
command's first word.

The command runs in the run directory the client names (the project dir, or
bun's package dir). A first word holding no `/` is looked up on PATH; one
holding a `/` is resolved against the run directory. A command that is not
found is refused, naming it, and nothing is posted. stdout and stderr are
captured as one ordered stream, in text mode, and posted whole, a clean run
that printed nothing included. The linter's exit is the verdict, whether or
not the board took the post.

The clients' `runs` and `run` read a lint record back through `lint_brief`,
`lint_run_row` and `compile_run_line`: it stays `kind: "compile"`, carries
`lint`, and its line names `lint` and the tool, never `compile`.

No client loads this module. The core, `_crucible_axi.py`, loads it by file
path from its own directory, under a name derived from its own, and
re-exports every name it defines, so a client reaches `_axi().cmd_lint`. Every
core name used here is read through `_core`, a live view of the core's
namespace bound at load time.

It imports only the standard library.
"""

import os
import shutil
import subprocess
import typing

#: The core this module is bound to: a live view of `_crucible_axi.py`'s
#: namespace, set by the core's loader once this module has run.
_core: typing.Any = None

LINT_VERB = "lint"
LINT_TABLE = "lint"

#: The envelope's `skipped` value when nothing is declared and the stack has
#: no default.
LINT_SKIPPED_NOT_DECLARED = "not-declared"

#: The envelope's `declared` value of a stack default.
LINT_DECLARED_DEFAULT = "default"

LINT_VERB_HELP = (
    "Run the project's linter -- the `[lint]` table of its crucible.toml, else "
    "the stack's default -- and, with --agent, file its output on the board "
    "as a lint record. The linter's exit is the verdict; nothing declared is "
    "a skip.")

_AGENT_HELP = ("Agent id to file the lint result under. Without it the "
               "linter runs and nothing is posted.")


class LintRefused(ValueError):
    """A lint run refused before its linter ran: a malformed `[lint]` table,
    or a command that is not found. The message names the file or the
    command."""


def add_lint_verb(sub, func, add_args=()):
    """Register `lint [--agent ID] [--cycle N]` on a client's subparsers, with
    `add_args` (the client's own project-dir flag) after, so the six clients
    cannot drift into six flag surfaces."""
    parser = sub.add_parser(LINT_VERB, help=LINT_VERB_HELP)
    parser.add_argument("--agent", help=_AGENT_HELP)
    _core.add_filing_cycle_arg(parser)
    for adder in add_args:
        adder(parser)
    parser.set_defaults(func=func)
    return parser


def lint_default(command, fmt, *, env=None, run_dirs=None):
    """A stack's default linter: `command` run with `env` laid under the
    caller's environment (a variable already set is kept), once in each of
    `run_dirs` (the run directory alone when None), formatted as `fmt`."""
    return {"command": list(command), "format": fmt, "env": dict(env or {}),
            "run_dirs": list(run_dirs) if run_dirs else None}


def _field_refusal(path, detail):
    return LintRefused(
        f"{path} declares a [{LINT_TABLE}] table whose {detail} -- write it as "
        f"`command = [\"ruff\", \"check\", \".\"]`, with an optional string "
        f"`format` and `name`")


def resolve_lint_declaration(default=None):
    """`(spec, declared)` -- what `lint` runs, and where it came from:
    `declared:<file>` for a `[lint]` table, `default` for the stack default,
    or `(None, None)` when there is neither. Raises `LintRefused`, naming the
    file, for a malformed table."""
    path, table = _core._read_project_config(LINT_TABLE)
    if not table:
        if default is None:
            return None, None
        return default, LINT_DECLARED_DEFAULT
    command = table.get("command")
    if not isinstance(command, list):
        raise _field_refusal(path, f"`command` is {command!r}, not a list")
    if not command:
        raise _field_refusal(path, "`command` is an empty list")
    if not all(isinstance(word, str) and word for word in command):
        raise _field_refusal(path, f"`command` {command!r} holds an empty or "
                                   f"non-string entry")
    for field in ("format", "name"):
        if field in table and not (isinstance(table[field], str) and table[field]):
            raise _field_refusal(path, f"`{field}` is {table[field]!r}, not a "
                                       f"non-empty string")
    spec = {"command": list(command), "format": table.get("format"),
            "name": table.get("name"), "env": {}, "run_dirs": None}
    return spec, _core.gate_skip_declared_source(path)


def lint_marker(spec):
    """The marker: the declared `name`, else the `format`, else the basename
    of the command's first word."""
    return (spec.get("name") or spec.get("format")
            or os.path.basename(spec["command"][0]))


def resolve_lint_command(word, run_dir, path_variable):
    """The executable `word` names: looked up on `path_variable` when it holds
    no `/`, else resolved against `run_dir`. Raises `LintRefused`, naming it,
    when it is not found."""
    if "/" in word:
        candidate = os.path.normpath(os.path.join(run_dir, word))
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return os.path.abspath(candidate)
        raise LintRefused(f"the lint command {word!r} was not found: no "
                          f"executable at {candidate}")
    found = shutil.which(word, path=path_variable)
    if found is None:
        raise LintRefused(f"the lint command {word!r} was not found on PATH")
    return found


def run_lint_command(spec, run_dir):
    """Run `spec` in each of its run directories (`run_dir` alone when it
    names none), stdout and stderr captured as one ordered stream. Returns
    `(output, exit)`: the outputs joined in order, and the first non-zero
    exit, or 0."""
    env = os.environ.copy()
    for key, value in spec.get("env", {}).items():
        env.setdefault(key, value)
    dirs = spec.get("run_dirs") or [run_dir]
    executable = resolve_lint_command(spec["command"][0], run_dir, env.get("PATH"))
    outputs, exit_code = [], 0
    for directory in dirs:
        try:
            result = subprocess.run(
                [executable, *spec["command"][1:]], cwd=directory, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                check=False)
        except OSError as error:
            raise LintRefused(f"the lint command {spec['command'][0]!r} could "
                              f"not be run: {error}") from error
        outputs.append(result.stdout or "")
        if exit_code == 0:
            exit_code = result.returncode
    return "".join(outputs), exit_code


def _file_lint(ops, project_dir, agent_id, cycle_id, stack, spec, marker,
               output, exit_code):
    """Post one lint run on the compile route. Returns the board's answer."""
    payload = {"projectKey": ops.project_key(project_dir), "agentId": agent_id,
               "errors": output, "lint": marker, "runnerExit": exit_code}
    if spec.get("format"):
        payload["format"] = spec["format"]
    context = _core.cycle_context(_core.run_context(), cycle_id)
    if context:
        payload["context"] = context
    return _core.post_ingest(ops.post, _core.COMPILE_INGEST_PATH, payload,
                             stack=stack) or {}


def _lint_help(ok, marker):
    if ok:
        return [f"{marker} is clean: run the tests next"]
    return [f"fix what {marker} reported, then re-run {LINT_VERB}"]


def _emit_lint_refusal(ops, project_dir, agent_id, warnings, refusal):
    error = str(refusal)
    ops.emit(LINT_VERB, False,
             {"error": error,
              "help": [f"correct the [{LINT_TABLE}] declaration or the "
                       f"command this error names, then re-run {LINT_VERB}"]},
             ops.context(project_dir, agent_id=agent_id), warnings,
             f"{LINT_VERB}: ok=False error={error}")
    return 1


def cmd_lint(args, project_dir, ops, *, stack, run_dir=None, default=None):
    """`lint`: the gated-run pre-flight, then the declared linter (or
    `default`) in `run_dir` (the project dir when None), then -- with
    `--agent` -- one post of its output on the compile route.

    The envelope names the `linter`, where it was `declared`, its `exit`, the
    board's `errors` and `lints` counts and the filed `event` (each null when
    nothing was filed), or `skipped: not-declared`. A board that refused the
    post, or never answered, adds the ingest-failed warning; the verdict is
    the linter's exit either way."""
    agent_id = getattr(args, "agent", None)
    cycle_id = getattr(args, "cycle", None)
    warnings = list(_core.preflight_cycle_warnings(
        ops.get, ops.project_key(project_dir) if agent_id else None, agent_id,
        cycle_id=cycle_id, context=_core.run_context()))
    run_dir = run_dir or project_dir
    try:
        spec, declared = resolve_lint_declaration(default)
        if spec is None:
            ops.emit(LINT_VERB, True,
                     {"skipped": LINT_SKIPPED_NOT_DECLARED,
                      "help": [f"declare the project's linter in a "
                               f"[{LINT_TABLE}] table of its crucible.toml"]},
                     ops.context(project_dir, agent_id=agent_id), warnings,
                     f"{LINT_VERB}: ok=True skipped={LINT_SKIPPED_NOT_DECLARED}")
            return 0
        output, exit_code = run_lint_command(spec, run_dir)
    except LintRefused as refusal:
        return _emit_lint_refusal(ops, project_dir, agent_id, warnings, refusal)
    marker = lint_marker(spec)
    errors = lints = event = None
    if agent_id:
        resp = _file_lint(ops, project_dir, agent_id, cycle_id, stack, spec,
                          marker, output, exit_code)
        if resp.get("ok"):
            errors, lints, event = (resp.get("errors"), resp.get("warnings"),
                                    resp.get("event"))
        else:
            warnings.append(_core.ingest_failed_warning(LINT_VERB, ops.base_url))
    ok = exit_code == 0
    ops.emit(LINT_VERB, ok,
             {"linter": marker, "declared": declared, "exit": exit_code,
              "errors": errors, "lints": lints, "event": event,
              "help": _lint_help(ok, marker)},
             ops.context(project_dir, agent_id=agent_id), warnings,
             f"{LINT_VERB}: ok={ok} linter={marker} exit={exit_code}")
    return 0 if ok else 1


# ── a lint record read back by `runs` and `run` ─────────────────────────────

def lint_brief(brief, event):
    """A stored run's brief with the record's `lint` beside its `kind`, when
    a linter filed it; a compile record's brief is returned unchanged."""
    if event.get("lint"):
        brief["lint"] = event["lint"]
    return brief


def lint_run_row(row, event):
    """A `runs` row with the record's `lint`, when a linter filed it; every
    other row keeps its columns."""
    return lint_brief(row, event)


def compile_run_line(event_id, brief):
    """`run`'s line for a compile-kind record: `lint <tool>` for a lint
    record, else `compile`, then its two counts."""
    words = f"{LINT_VERB} {brief['lint']}" if brief.get("lint") else "compile"
    return (f"run: ok=True {event_id} {words} errors={brief.get('errors')} "
            f"warnings={brief.get('warnings')}")
