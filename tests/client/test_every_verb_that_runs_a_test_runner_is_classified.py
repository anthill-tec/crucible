"""Every subcommand of every client is classified against the runner-exit rule.

The rule: a verb that runs a test runner sends the runner's exit as
`runnerExit` on its ingest and exits through `verb_exit`, so a runner that
failed is never filed or exited as green. A rule held by five clients over
some two hundred subcommands is only held if nothing escapes it, so this
module is a CENSUS:

  * the subcommands are ENUMERATED from each client's real argparse — the
    parser `main()` builds, captured the instant it calls `parse_args()`, the
    way `test_client_fleet_envelope_census.enumerate_verbs` captures it — and
    never from a list kept here. Each subcommand's handler is read off its
    `func` default; a declared-tier verb's handler (the shared
    `declared_tier_run` closure) is unwrapped to the client's own RUN function
    its `DeclaredTierSurface` carries.
  * every subcommand must be CLASSIFIED in `CENSUS` below, in exactly one of
    three classes:
      - `applies(body)` — it runs a test runner, and `body` is the function
        that runs it and files its run;
      - `exempt(reason)` — it files something, but not a test runner's run
        (`auto-ingest` runs no runner; `check`/`compile`/`clippy` file a
        compile ingest);
      - `not_ingesting(reason)` — it files no run at all.
    A subcommand the census does not name FAILS the census, so a verb added
    to any parser has to be classified before the suite is green again; an
    entry naming a verb no parser has fails it too.
  * each class is CHECKED against the client's own source by a static call
    graph (module-level functions referenced by name, transitively), so a
    wrapper (`cmd_test` -> `_test_run`, `_run_native_tests` ->
    `_run_native_tests_body`) neither hides a body nor breaks the check:
      - an applying verb's handler must reach its named body;
      - the body — following its own helpers, but taking no credit from
        another census body — must compute the exit with `runner_exit_code`,
        reach an ingest helper that both puts `runnerExit` in its payload and
        posts it (`post_ingest`), and RETURN a value derived from `verb_exit`
        (directly, through a local it was assigned to, or through a helper
        that itself returns one);
      - an exempt verb must reach an ingest helper (it files something) and
        must not compute a runner exit;
      - a not-ingesting verb must reach no ingest helper and compute no
        runner exit.

The checker itself is proved on synthetic client sources (a real argparse
`main()` written to a scratch file and enumerated by the same code): one
compliant verb behind a wrapper chain, and one mutant per finding the census
can raise.

What the static graph does not follow: calls made through the shared module
(`_axi().<fn>`, `_ops().<fn>`) are leaves. The behaviour those shared pieces
contribute — `verb_exit`, `runner_exit_code`, the gate composition — is pinned
by the behavioural suites beside this one (`test_the_shared_exit_functions`,
the per-client `test_<stack>_exits_and_files_on_its_runners_exit` suites and
`test_no_composed_gate_is_green_on_a_failed_runner`).

Invocation:
    python3 -m unittest tests.client.test_every_verb_that_runs_a_test_runner_is_classified -v
"""

import argparse
import ast
import functools
import importlib.util
import inspect
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import NamedTuple
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
CLIENT_KEYS = ("bun", "python", "mvn", "rust", "arduino")

APPLIES, EXEMPT, NOT_INGESTING = "applies", "exempt", "not-ingesting"


class Entry(NamedTuple):
    """One census classification: its class, and the body (for `applies`) or
    the stated reason (for the other two)."""
    kind: str
    detail: str


def applies(body):
    return Entry(APPLIES, body)


def exempt(reason):
    return Entry(EXEMPT, reason)


def not_ingesting(reason):
    return Entry(NOT_INGESTING, reason)


# ── the census ──────────────────────────────────────────────────────────────

_RUNS_NO_RUNNER = exempt(
    "auto-ingest runs no runner: it files a report already on disk, so there "
    "is no runner exit to send")
_COMPILE_GATE = exempt(
    "a compile gate: it files a compile ingest and runs no test runner, and a "
    "compile ingest's code never decides a test verb's exit")
_LINT_GATE = exempt(
    "a lint gate: it files rustc diagnostics as a compile ingest and runs no "
    "test runner")
_DOCKER = not_ingesting(
    "brings the project's compose stack up or down; runs no test runner and "
    "files nothing")

_LIFECYCLE = not_ingesting(
    "agent lifecycle: registers or removes an agent; files no run")
_PLAN = not_ingesting(
    "a plan/cycle verb: writes the board's plan state; runs no test runner "
    "and files no run")
_READ = not_ingesting("a read verb: asks the board and prints what it answers")
_ROADMAP = not_ingesting(
    "a roadmap/queue verb: writes the board's roadmap or queue; files no run")
_GATE_RECORD = not_ingesting(
    "a gate-record verb: proxies or records the no-mistakes gate and its "
    "decision; files no test run")

# The verbs every client registers through the shared registrars, none of which
# runs a test runner. A client lacking one simply has no such subcommand.
SHARED_CENSUS = {
    "register": _LIFECYCLE,
    "unregister": _LIFECYCLE,
    "plan-file": _PLAN,
    "plan-backfill": _PLAN,
    "cycle-activate": _PLAN,
    "cycle-done": _PLAN,
    "cycle-skip": _PLAN,
    "cycle-add": _PLAN,
    "cr-close": _PLAN,
    "checkpoint": _PLAN,
    "stop": _PLAN,
    "abort": _PLAN,
    "status": _READ,
    "plans": _READ,
    "queue": _READ,
    "landings": _READ,
    "history": _READ,
    "next": _READ,
    "cr-depends": _ROADMAP,
    "project-meta": _ROADMAP,
    "release-propose": _ROADMAP,
    "cr-plan": _ROADMAP,
    "wave-sequence": _ROADMAP,
    "cr-supersede": _ROADMAP,
    "cr-void": _ROADMAP,
    "queue-file": _ROADMAP,
    "milestone": _ROADMAP,
    "gate-run": _GATE_RECORD,
    "gate-respond": _GATE_RECORD,
    "gate-report": _GATE_RECORD,
}

# The stored-run read verbs (CR-CRU-216 §S3): read-only, filing nothing. Named
# in EVERY client's own census below rather than in `SHARED_CENSUS`, whose
# entries a client may lack without a finding: the spec owes both verbs to all
# five clients, so a client missing either is a census finding.
_STORED_RUN_READ = _READ

# Each client's own verbs. A declared tier verb (one the shared
# `declared_tier_run` registers) is classified by the body its client's
# declared-target RUN function reaches.
CLIENT_CENSUS = {
    "bun": {
        "test": applies("cmd_test"),
        "regression": applies("cmd_regression"),
        "unit": applies("cmd_regression"),
        "module": applies("cmd_regression"),
        "integration": applies("cmd_regression"),
        "e2e": applies("cmd_regression"),
        "bdd": applies("cmd_regression"),
        "pre-merge-gate": applies("cmd_regression"),
        "auto-ingest": _RUNS_NO_RUNNER,
        "check": _COMPILE_GATE,
        "runs": _STORED_RUN_READ,
        "run": _STORED_RUN_READ,
    },
    "python": {
        "test": applies("_test_run"),
        "unit": applies("_test_run"),
        "module": applies("_test_run"),
        "integration": applies("_test_run"),
        "e2e": applies("_test_run"),
        "bdd": applies("_test_run"),
        "regression": applies("_regression_run"),
        "pre-merge-gate": applies("_regression_run"),
        "auto-ingest": _RUNS_NO_RUNNER,
        "check": _COMPILE_GATE,
        "runs": _STORED_RUN_READ,
        "run": _STORED_RUN_READ,
    },
    "mvn": {
        "unit": applies("_surefire_tier_run"),
        "module": applies("_surefire_tier_run"),
        "bdd": applies("_surefire_tier_run"),
        "integration": applies("_failsafe_tier_run"),
        "e2e": applies("_failsafe_tier_run"),
        "regression": applies("cmd_regression"),
        "pre-merge-gate": applies("cmd_regression"),
        "test": applies("_test_run"),
        "auto-ingest": _RUNS_NO_RUNNER,
        "check": _COMPILE_GATE,
        "compile": _COMPILE_GATE,
        "docker-up": _DOCKER,
        "docker-down": _DOCKER,
        "runs": _STORED_RUN_READ,
        "run": _STORED_RUN_READ,
    },
    "rust": {
        "test": applies("_test_run"),
        "unit": applies("_test_run"),
        "integration": applies("_test_run"),
        "e2e": applies("_test_run"),
        "module": applies("_test_run"),
        "bdd": applies("_test_run"),
        # `smoke-test` reaches the smoke body through `cmd_smoke_test`, and
        # `docker-e2e-gate` through the identity-less `_smoke_test` wrapper;
        # both arrive at `_smoke_run`, the function that runs nextest and files.
        "smoke-test": applies("_smoke_run"),
        "docker-e2e-gate": applies("_smoke_run"),
        "workspace-regression": applies("_workspace_regression_run"),
        "regression": applies("_workspace_regression_run"),
        "pre-merge-gate": applies("_workspace_regression_run"),
        "regression-ingest": applies("_regression_ingest_run"),
        "auto-ingest": _RUNS_NO_RUNNER,
        "check": _COMPILE_GATE,
        "clippy": _LINT_GATE,
        "workspace-clippy": _LINT_GATE,
        "docker-up": _DOCKER,
        "docker-down": _DOCKER,
        "runs": _STORED_RUN_READ,
        "run": _STORED_RUN_READ,
    },
    "arduino": {
        "test": applies("_run_native_tests"),
        "unit": applies("_run_native_tests"),
        "regression": applies("_run_native_tests"),
        "module": applies("_run_native_tests"),
        "integration": applies("_run_native_tests"),
        "e2e": applies("_run_native_tests"),
        "bdd": applies("_run_native_tests"),
        "pre-merge-gate": applies("_run_native_tests"),
        "auto-ingest": _RUNS_NO_RUNNER,
        "check": _COMPILE_GATE,
        "compile": _COMPILE_GATE,
        "runs": _STORED_RUN_READ,
        "run": _STORED_RUN_READ,
    },
}


# ── enumeration: the subcommands and their handlers, from the real parser ──

class _ParserCaptured(Exception):
    def __init__(self, parser):
        super().__init__("parser captured before dispatch")
        self.parser = parser


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _handler_name(func):
    """The client function a subcommand dispatches to. A declared-tier verb's
    `func` is the shared `declared_tier_run` closure; what it runs is its
    surface's `run`, the client's own function."""
    if getattr(func, "__name__", None) == "_run_declared_tier":
        surface = inspect.getclosurevars(func).nonlocals.get("surface")
        run = getattr(surface, "run", None)
        if run is None:
            raise AssertionError(
                f"a declared-tier handler carries no surface with a `run`: "
                f"{func!r}")
        return run.__name__
    return func.__name__


def verb_handlers(script_path, module_name):
    """`{subcommand: handler function name}`, read off the parser the client's
    `main()` builds — captured at its one `parse_args()` call, before any
    subcommand runs."""
    module = _load_module(script_path, module_name)

    def _capture(self, *_args, **_kwargs):
        raise _ParserCaptured(self)

    with mock.patch.object(argparse.ArgumentParser, "parse_args", _capture), \
            mock.patch.object(sys, "argv", [Path(script_path).name]):
        try:
            module.main()
        except _ParserCaptured as captured:
            parser = captured.parser
        else:
            raise AssertionError(
                f"{script_path}: main() returned without calling parse_args()")
    subparsers = [action for action in parser._actions
                  if isinstance(action, argparse._SubParsersAction)]
    if len(subparsers) != 1:
        raise AssertionError(
            f"{script_path}: expected one subparsers action, found "
            f"{len(subparsers)}")
    handlers = {}
    for verb, subparser in subparsers[0].choices.items():
        func = subparser.get_default("func")
        if func is None:
            raise AssertionError(f"{script_path}: `{verb}` sets no func default")
        handlers[verb] = _handler_name(func)
    return handlers


# ── the static call graph over one client's source ─────────────────────────

def _callee_name(call):
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


# The ingest calls the census recognises: `post_ingest`, and the shared ingest
# in `clients/_crucible_axi.py`, which sends through `post_ingest` itself and
# puts the `runner_exit=` it is handed on the body as `runnerExit`.
SHARED_INGEST = "ingest_reports"
INGEST_CALLEES = ("post_ingest", SHARED_INGEST)


def _shared_ingest_name():
    """`SHARED_INGEST`, once the shared module is shown to define it: a census
    keyed to a name the shared module does not carry would recognise nothing."""
    axi = _load_module(CLIENTS_DIR / "_crucible_axi.py",
                       "runner_exit_census_shared_ingest_name")
    return getattr(axi, SHARED_INGEST).__name__


class ClientSource:
    """One client's module-level functions and the facts the census reads off
    them."""

    def __init__(self, source):
        tree = ast.parse(source)
        self.functions = {node.name: node for node in tree.body
                          if isinstance(node, ast.FunctionDef)}
        self.edges = {name: self._referenced(name, node)
                      for name, node in self.functions.items()}
        self.computes_runner_exit = {
            name for name, node in self.functions.items()
            if self._calls(node, "runner_exit_code")}
        self.posts_ingest = {
            name for name, node in self.functions.items()
            if any(self._calls(node, callee) for callee in INGEST_CALLEES)}
        self.sends_runner_exit = {
            name for name in self.posts_ingest
            if any(isinstance(n, ast.Constant) and n.value == "runnerExit"
                   for n in ast.walk(self.functions[name]))
            or self._hands_the_shared_ingest_a_runner_exit(self.functions[name])}
        self._returns_memo = {}

    @staticmethod
    def _hands_the_shared_ingest_a_runner_exit(node):
        """A call of the shared ingest handed a `runner_exit=` that is not the
        literal `None`: the shared ingest puts it on the body as `runnerExit`."""
        return any(
            isinstance(n, ast.Call) and _callee_name(n) == SHARED_INGEST
            and any(k.arg == "runner_exit"
                    and not (isinstance(k.value, ast.Constant)
                             and k.value.value is None)
                    for k in n.keywords)
            for n in ast.walk(node))

    def _referenced(self, name, node):
        return {n.id for n in ast.walk(node)
                if isinstance(n, ast.Name) and n.id in self.functions
                and n.id != name}

    @staticmethod
    def _calls(node, callee):
        return any(isinstance(n, ast.Call) and _callee_name(n) == callee
                   for n in ast.walk(node))

    def reach(self, start, stop=frozenset()):
        """`start` and every module-level function it references, transitively,
        never entering a function in `stop`."""
        seen, todo = set(), [start]
        while todo:
            name = todo.pop()
            if name in seen or name not in self.functions:
                continue
            seen.add(name)
            todo.extend(n for n in self.edges[name] if n not in stop)
        return seen

    def returns_verb_exit(self, name, stop=frozenset()):
        """Whether a `return` of `name` hands back the verdict of the run it
        FILED: a `verb_exit` call one of whose arguments derives from the
        response of an ingest that sends `runnerExit` — returned directly,
        through a local assigned from one, or through a module function
        (outside `stop`) that itself returns one.

        A `verb_exit` over something else (a no-report branch's
        `{"ok": rc == 0}`) does not answer for the ingest path: a body whose
        filed run's verdict never reaches its exit is caught even when another
        branch of it returns `verb_exit`."""
        key = (name, stop)
        if key in self._returns_memo:
            return self._returns_memo[key]
        self._returns_memo[key] = False  # a cycle proves nothing
        node = self.functions[name]
        from_ingest_names, verdict_names = set(), set()

        def is_ingest_call(call):
            callee = _callee_name(call)
            if callee in INGEST_CALLEES:
                return name in self.sends_runner_exit
            return (callee in self.functions and callee != name
                    and callee not in stop
                    and bool(self.reach(callee, stop) & self.sends_runner_exit))

        def from_ingest(expr):
            return any(
                (isinstance(n, ast.Name) and n.id in from_ingest_names)
                or (isinstance(n, ast.Call) and is_ingest_call(n))
                for n in ast.walk(expr))

        def is_verdict(expr):
            for n in ast.walk(expr):
                if isinstance(n, ast.Name) and n.id in verdict_names:
                    return True
                if not isinstance(n, ast.Call):
                    continue
                callee = _callee_name(n)
                if callee == "verb_exit":
                    arguments = list(n.args) + [k.value for k in n.keywords]
                    if any(from_ingest(a) for a in arguments):
                        return True
                elif (callee in self.functions and callee != name
                        and callee not in stop
                        and self.returns_verb_exit(callee, stop)):
                    return True
            return False

        assignments = [n for n in ast.walk(node)
                       if isinstance(n, (ast.Assign, ast.AnnAssign, ast.AugAssign))
                       and n.value is not None]
        changed = True
        while changed:
            changed = False
            for assignment in assignments:
                targets = (assignment.targets if isinstance(assignment, ast.Assign)
                           else [assignment.target])
                names = {n.id for target in targets for n in ast.walk(target)
                         if isinstance(n, ast.Name)}
                for test, bucket in ((from_ingest, from_ingest_names),
                                     (is_verdict, verdict_names)):
                    if names - bucket and test(assignment.value):
                        bucket.update(names)
                        changed = True
        result = any(isinstance(n, ast.Return) and n.value is not None
                     and is_verdict(n.value) for n in ast.walk(node))
        self._returns_memo[key] = result
        return result


# ── the census check ───────────────────────────────────────────────────────

def census_findings(client, source, handlers, census):
    """Every way `client`'s subcommands (`handlers`: verb -> handler name)
    disagree with `census` (verb -> Entry), checked against `source`. An empty
    list is a client that holds the rule on every verb."""
    code = ClientSource(source)
    findings = []
    bodies = {entry.detail for entry in census.values() if entry.kind == APPLIES}

    for verb in sorted(set(handlers) - set(census)):
        findings.append(
            f"{client} `{verb}`: unclassified — the census names no class for "
            f"it (applies / exempt / not-ingesting)")

    for verb in sorted(set(handlers) & set(census)):
        entry, handler = census[verb], handlers[verb]
        if handler not in code.functions:
            findings.append(
                f"{client} `{verb}`: its handler `{handler}` is not a "
                f"module-level function of the client")
            continue
        reached = code.reach(handler)
        if entry.kind == APPLIES:
            if entry.detail not in reached:
                findings.append(
                    f"{client} `{verb}`: its handler `{handler}` never reaches "
                    f"the body the census names, `{entry.detail}`")
            continue
        if not entry.detail.strip():
            findings.append(f"{client} `{verb}`: classified {entry.kind} with "
                            f"no stated reason")
        runners = sorted(reached & code.computes_runner_exit)
        if runners:
            findings.append(
                f"{client} `{verb}`: classified {entry.kind}, yet it reaches "
                f"{runners}, which compute a runner exit — a verb that runs a "
                f"test runner applies the rule")
        ingests = sorted(reached & code.posts_ingest)
        if entry.kind == EXEMPT and not ingests:
            findings.append(
                f"{client} `{verb}`: classified exempt, yet it reaches no "
                f"ingest — a verb that files nothing is not-ingesting")
        if entry.kind == NOT_INGESTING and ingests:
            findings.append(
                f"{client} `{verb}`: classified not-ingesting, yet it reaches "
                f"the ingest helper(s) {ingests}")

    for body in sorted(bodies):
        if body not in code.functions:
            findings.append(f"{client}: the census body `{body}` is not a "
                            f"module-level function of the client")
            continue
        others = frozenset(bodies - {body})
        own = code.reach(body, stop=others)
        if not own & code.computes_runner_exit:
            findings.append(
                f"{client} body `{body}`: never computes the runner's exit "
                f"with runner_exit_code")
        if not own & code.sends_runner_exit:
            findings.append(
                f"{client} body `{body}`: sends no `runnerExit` — it reaches no "
                f"ingest that puts `runnerExit` in the payload it posts")
        if not code.returns_verb_exit(body, stop=others):
            findings.append(
                f"{client} body `{body}`: does not return verb_exit — its exit "
                f"is not the runner's and the filed run's")

    for verb in sorted(set(census) - set(handlers)):
        if verb in SHARED_CENSUS and census[verb] == SHARED_CENSUS[verb]:
            continue
        findings.append(
            f"{client} `{verb}`: the census names a subcommand the client's "
            f"parser does not have")
    return findings


def client_census(client):
    return {**SHARED_CENSUS, **CLIENT_CENSUS[client]}


@functools.cache
def _client_handlers(client):
    return verb_handlers(CLIENTS_DIR / f"{client}-crucible.py",
                         f"runner_exit_census_{client}")


@functools.cache
def _client_source(client):
    return (CLIENTS_DIR / f"{client}-crucible.py").read_text()


# ── the census over the five real clients ──────────────────────────────────

class EveryClientsVerbsAreClassifiedTest(unittest.TestCase):
    """The census, over the subcommands each real client's parser holds."""

    def findings(self, client):
        return census_findings(client, _client_source(client),
                               _client_handlers(client), client_census(client))

    def test_every_client_holds_the_rule_on_every_subcommand(self):
        findings = {client: self.findings(client) for client in CLIENT_KEYS}
        self.assertEqual(
            {client: f for client, f in findings.items() if f}, {},
            "every subcommand of every client is classified, and each class "
            "holds against the client's source:\n" + "\n".join(
                line for lines in findings.values() for line in lines))

    def test_the_enumeration_reads_each_clients_real_parser(self):
        # A census over an empty or truncated enumeration would pass vacuously.
        for client in CLIENT_KEYS:
            with self.subTest(client=client):
                handlers = _client_handlers(client)
                self.assertGreaterEqual(
                    len(handlers), 30,
                    f"{client}: the parser enumerated only {sorted(handlers)}")
                for verb in ("register", "pre-merge-gate", "auto-ingest",
                             "check", "unit", "regression", "bdd"):
                    self.assertIn(verb, handlers,
                                  f"{client}: `{verb}` missing from the "
                                  f"enumerated subcommands {sorted(handlers)}")

    def test_every_client_applies_the_rule_to_at_least_its_test_and_gate_verbs(self):
        for client in CLIENT_KEYS:
            census = client_census(client)
            with self.subTest(client=client):
                for verb in ("test", "unit", "regression", "pre-merge-gate"):
                    self.assertEqual(
                        census[verb].kind, APPLIES,
                        f"{client} `{verb}` runs a test runner; the census "
                        f"classifies it {census[verb]!r}")

    def test_a_declared_tier_verb_is_classified_by_the_clients_own_run_function(self):
        # `bdd` is a declared-tier cell in all five clients: its handler is
        # unwrapped to the client's declared-target RUN, never the shared
        # closure's own name.
        expected = {"bun": "_run_declared_script",
                    "python": "_run_declared_discovery",
                    "mvn": "_run_declared_profile",
                    "rust": "_run_declared_nextest_profile",
                    "arduino": "_run_declared_make_target"}
        self.assertEqual(
            {client: _client_handlers(client)["bdd"] for client in CLIENT_KEYS},
            expected)


# ── the checker, proved on a synthetic client ──────────────────────────────

_SYNTHETIC_CLIENT = textwrap.dedent('''
    """A synthetic client: one compliant verb behind a wrapper chain, and one
    mutant per finding the runner-exit census raises."""
    import argparse


    def _axi():
        raise RuntimeError("never run: the census only reads this source")


    def _ingest(counts, runner_exit):
        payload = {"summary": counts}
        payload["runnerExit"] = runner_exit
        return _axi().post_ingest(None, "/api/v2/runs/parsed", payload,
                                  stack="synthetic")


    def _ingest_without_exit(counts):
        payload = {"summary": counts}
        return _axi().post_ingest(None, "/api/v2/runs/parsed", payload,
                                  stack="synthetic")


    def _run_body(args):
        result = _axi().spawn(args)
        runner_exit = _axi().runner_exit_code(result.returncode)
        resp = _ingest({}, runner_exit)
        exit_code = _axi().verb_exit(runner_exit, resp)
        return exit_code


    def _run_through(args):
        return _run_body(args)


    def cmd_wrapped(args):
        return _run_through(args)


    def _silent_body(args):
        result = _axi().spawn(args)
        runner_exit = _axi().runner_exit_code(result.returncode)
        resp = _ingest_without_exit({})
        return _axi().verb_exit(runner_exit, resp)


    def cmd_silent(args):
        return _silent_body(args)


    def _ingest_code_body(args):
        result = _axi().spawn(args)
        runner_exit = _axi().runner_exit_code(result.returncode)
        resp = _ingest({}, runner_exit)
        _axi().verb_exit(runner_exit, resp)
        return 0 if resp.get("ok") else 1


    def cmd_ingest_code(args):
        return _ingest_code_body(args)


    def _half_body(args):
        result = _axi().spawn(args)
        runner_exit = _axi().runner_exit_code(result.returncode)
        if result.report is None:
            rc = _axi().compile_fallback(args)
            return _axi().verb_exit(runner_exit, {"ok": rc == 0})
        resp = _ingest({}, runner_exit)
        return 0 if resp.get("ok") else 1


    def cmd_half(args):
        return _half_body(args)


    def _blind_body(args):
        _axi().spawn(args)
        resp = _ingest({}, 0)
        return _axi().verb_exit(0, resp)


    def cmd_blind(args):
        return _blind_body(args)


    def _borrowing_body(args):
        return _run_body(args)


    def cmd_borrowing(args):
        return _borrowing_body(args)


    def cmd_elsewhere(args):
        return 0


    def cmd_compile(args):
        return 0 if _ingest_without_exit({}).get("ok") else 1


    def cmd_sneaky(args):
        return _run_through(args)


    def cmd_quiet(args):
        return 0


    def cmd_chatty(args):
        _ingest_without_exit({})
        return 0


    def cmd_unlisted(args):
        return 0


    def main():
        p = argparse.ArgumentParser()
        sub = p.add_subparsers(dest="cmd", required=True)
        for verb, func in (("wrapped", cmd_wrapped), ("silent", cmd_silent),
                           ("ingest-code", cmd_ingest_code),
                           ("half", cmd_half),
                           ("blind", cmd_blind), ("borrowing", cmd_borrowing),
                           ("elsewhere", cmd_elsewhere),
                           ("compile", cmd_compile), ("sneaky", cmd_sneaky),
                           ("quiet", cmd_quiet), ("chatty", cmd_chatty),
                           ("unlisted", cmd_unlisted)):
            sub.add_parser(verb).set_defaults(func=func)
        args = p.parse_args()
        return args.func(args)
''')

_SYNTHETIC_CENSUS = {
    "wrapped": applies("_run_body"),
    "silent": applies("_silent_body"),
    "ingest-code": applies("_ingest_code_body"),
    "half": applies("_half_body"),
    "blind": applies("_blind_body"),
    "borrowing": applies("_borrowing_body"),
    "elsewhere": applies("_silent_body"),
    "compile": exempt("a compile gate"),
    "sneaky": exempt("claims to run no runner"),
    "quiet": not_ingesting("files nothing"),
    "chatty": not_ingesting("claims to file nothing"),
    "stale-verb": not_ingesting("a verb the parser does not have"),
}


class TheCensusCheckerIsProvedOnASyntheticClientTest(unittest.TestCase):
    """The same enumeration and checker the real census uses, over a scratch
    client whose every mutant should raise exactly its own finding."""

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="runner-exit-census-synthetic-")
        path = Path(cls.tmpdir) / "synthetic-crucible.py"
        path.write_text(_SYNTHETIC_CLIENT)
        cls.handlers = verb_handlers(path, "runner_exit_census_synthetic")
        cls.findings = census_findings("synthetic", _SYNTHETIC_CLIENT,
                                       cls.handlers, _SYNTHETIC_CENSUS)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmpdir, ignore_errors=True)

    def about(self, needle):
        return [f for f in self.findings if needle in f]

    def test_the_enumeration_reads_the_synthetic_parser_whole(self):
        self.assertEqual(
            self.handlers,
            {"wrapped": "cmd_wrapped", "silent": "cmd_silent",
             "ingest-code": "cmd_ingest_code", "half": "cmd_half",
             "blind": "cmd_blind",
             "borrowing": "cmd_borrowing", "elsewhere": "cmd_elsewhere",
             "compile": "cmd_compile", "sneaky": "cmd_sneaky",
             "quiet": "cmd_quiet", "chatty": "cmd_chatty",
             "unlisted": "cmd_unlisted"})

    def test_a_compliant_body_behind_a_wrapper_chain_raises_nothing(self):
        self.assertEqual(self.about("`wrapped`"), [])
        self.assertEqual(self.about("body `_run_body`"), [])

    def test_an_unclassified_subcommand_fails_the_census(self):
        self.assertEqual(
            self.about("`unlisted`"),
            ["synthetic `unlisted`: unclassified — the census names no class "
             "for it (applies / exempt / not-ingesting)"])

    def test_a_census_entry_for_a_verb_the_parser_lacks_fails_the_census(self):
        self.assertEqual(
            self.about("`stale-verb`"),
            ["synthetic `stale-verb`: the census names a subcommand the "
             "client's parser does not have"])

    def test_a_body_that_never_sends_runner_exit_is_named(self):
        self.assertEqual(
            self.about("body `_silent_body`"),
            ["synthetic body `_silent_body`: sends no `runnerExit` \u2014 it "
             "reaches no ingest that puts `runnerExit` in the payload it posts",
             # and so the verb_exit it returns answers for no runnerExit ingest
             "synthetic body `_silent_body`: does not return verb_exit \u2014 "
             "its exit is not the runner's and the filed run's"])

    def test_a_body_that_returns_its_ingests_own_code_is_named(self):
        self.assertEqual(
            self.about("body `_ingest_code_body`"),
            ["synthetic body `_ingest_code_body`: does not return verb_exit — "
             "its exit is not the runner's and the filed run's"])

    def test_a_body_whose_filed_run_never_reaches_its_exit_is_named(self):
        # Its no-report branch returns verb_exit; the branch that FILES returns
        # the ingest's own code, so the filed run's verdict never decides it.
        self.assertEqual(
            self.about("body `_half_body`"),
            ["synthetic body `_half_body`: does not return verb_exit \u2014 "
             "its exit is not the runner's and the filed run's"])

    def test_a_body_that_never_computes_the_runner_exit_is_named(self):
        self.assertEqual(
            self.about("body `_blind_body`"),
            ["synthetic body `_blind_body`: never computes the runner's exit "
             "with runner_exit_code"])

    def test_a_body_takes_no_credit_from_another_census_body(self):
        self.assertEqual(
            self.about("body `_borrowing_body`"),
            ["synthetic body `_borrowing_body`: never computes the runner's "
             "exit with runner_exit_code",
             "synthetic body `_borrowing_body`: sends no `runnerExit` — it "
             "reaches no ingest that puts `runnerExit` in the payload it posts",
             "synthetic body `_borrowing_body`: does not return verb_exit — "
             "its exit is not the runner's and the filed run's"])

    def test_a_verb_whose_handler_never_reaches_its_named_body_is_named(self):
        self.assertEqual(
            self.about("`elsewhere`"),
            ["synthetic `elsewhere`: its handler `cmd_elsewhere` never reaches "
             "the body the census names, `_silent_body`"])

    def test_an_exempt_verb_that_runs_a_runner_is_named(self):
        self.assertEqual(
            self.about("`sneaky`"),
            ["synthetic `sneaky`: classified exempt, yet it reaches "
             "['_run_body'], which compute a runner exit — a verb that runs a "
             "test runner applies the rule"])

    def test_a_not_ingesting_verb_that_files_is_named(self):
        self.assertEqual(
            self.about("`chatty`"),
            ["synthetic `chatty`: classified not-ingesting, yet it reaches the "
             "ingest helper(s) ['_ingest_without_exit']"])

    def test_a_correctly_classified_exempt_and_not_ingesting_verb_raise_nothing(self):
        self.assertEqual(self.about("`compile`"), [])
        self.assertEqual(self.about("`quiet`"), [])

    def test_the_synthetic_client_raises_exactly_the_mutants_findings(self):
        # Bounded: no finding beyond the ones each mutant owes.
        self.assertEqual(len(self.findings), 13, "\n".join(self.findings))


# \u2500\u2500 the shared ingest is an ingest call, proved on a synthetic client \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

_SYNTHETIC_SHARED_INGEST_CLIENT = textwrap.dedent('''
    """A synthetic client whose verbs file through the shared ingest: one
    compliant body, and one mutant per way the seam can be misused."""
    import argparse

    _STACK = "synthetic"


    def _axi():
        raise RuntimeError("never run: the census only reads this source")


    def _post(path, payload):
        raise RuntimeError("never run")


    def _get(path):
        raise RuntimeError("never run")


    def _shared_body(args):
        result = _axi().spawn(args)
        runner_exit = _axi().runner_exit_code(result.returncode)
        resp = _axi().{shared}(_post, _get, codec="junit",
                               report_paths=result.reports, raw=result.output,
                               stack=_STACK, runner_exit=runner_exit)
        return _axi().verb_exit(runner_exit, resp)


    def cmd_shared(args):
        return _shared_body(args)


    def _exitless_body(args):
        result = _axi().spawn(args)
        runner_exit = _axi().runner_exit_code(result.returncode)
        resp = _axi().{shared}(_post, _get, codec="junit",
                               report_paths=result.reports, stack=_STACK)
        return _axi().verb_exit(runner_exit, resp)


    def cmd_exitless(args):
        return _exitless_body(args)


    def _none_exit_body(args):
        result = _axi().spawn(args)
        runner_exit = _axi().runner_exit_code(result.returncode)
        resp = _axi().{shared}(_post, _get, codec="junit",
                               report_paths=result.reports, stack=_STACK,
                               runner_exit=None)
        return _axi().verb_exit(runner_exit, resp)


    def cmd_none_exit(args):
        return _none_exit_body(args)


    def cmd_files_on_disk(args):
        resp = _axi().{shared}(_post, _get, codec="junit",
                               report_paths=args.reports, stack=_STACK)
        return 0 if resp.get("ok") else 1


    def cmd_quietly_files(args):
        _axi().{shared}(_post, _get, codec="junit", report_paths=args.reports,
                        stack=_STACK)
        return 0


    def main():
        p = argparse.ArgumentParser()
        sub = p.add_subparsers(dest="cmd", required=True)
        for verb, func in (("shared", cmd_shared), ("exitless", cmd_exitless),
                           ("none-exit", cmd_none_exit),
                           ("files-on-disk", cmd_files_on_disk),
                           ("quietly-files", cmd_quietly_files)):
            sub.add_parser(verb).set_defaults(func=func)
        args = p.parse_args()
        return args.func(args)
''')

_SYNTHETIC_SHARED_INGEST_CENSUS = {
    "shared": applies("_shared_body"),
    "exitless": applies("_exitless_body"),
    "none-exit": applies("_none_exit_body"),
    "files-on-disk": exempt("files a report already on disk; runs no runner"),
    "quietly-files": not_ingesting("claims to file nothing"),
}


class TheCensusReadsTheSharedIngestAsTheIngestCallTest(unittest.TestCase):
    """A client-module call of the shared ingest is the ingest call: handed a
    `runner_exit`, it sends `runnerExit`; reaching it is filing something."""

    @classmethod
    def setUpClass(cls):
        cls.source = _SYNTHETIC_SHARED_INGEST_CLIENT.replace(
            "{shared}", _shared_ingest_name())
        cls.tmpdir = tempfile.mkdtemp(prefix="runner-exit-census-shared-")
        path = Path(cls.tmpdir) / "synthetic-shared-crucible.py"
        path.write_text(cls.source)
        cls.handlers = verb_handlers(path, "runner_exit_census_synthetic_shared")
        cls.findings = census_findings("shared", cls.source, cls.handlers,
                                       _SYNTHETIC_SHARED_INGEST_CENSUS)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmpdir, ignore_errors=True)

    def about(self, needle):
        return [f for f in self.findings if needle in f]

    def test_a_body_handing_the_shared_ingest_its_runner_exit_applies_the_rule(self):
        self.assertEqual(self.about("`shared`"), [])
        self.assertEqual(self.about("body `_shared_body`"), [])

    def test_a_body_handing_the_shared_ingest_no_runner_exit_is_named(self):
        self.assertEqual(
            self.about("body `_exitless_body`"),
            ["shared body `_exitless_body`: sends no `runnerExit` \u2014 it "
             "reaches no ingest that puts `runnerExit` in the payload it posts",
             "shared body `_exitless_body`: does not return verb_exit \u2014 "
             "its exit is not the runner's and the filed run's"])

    def test_a_body_handing_the_shared_ingest_a_literal_none_runner_exit_is_named(self):
        self.assertEqual(
            self.about("body `_none_exit_body`"),
            ["shared body `_none_exit_body`: sends no `runnerExit` \u2014 it "
             "reaches no ingest that puts `runnerExit` in the payload it posts",
             "shared body `_none_exit_body`: does not return verb_exit \u2014 "
             "its exit is not the runner's and the filed run's"])

    def test_a_verb_filing_through_the_shared_ingest_without_a_runner_is_exempt(self):
        self.assertEqual(self.about("`files-on-disk`"), [])

    def test_a_not_ingesting_verb_that_calls_the_shared_ingest_is_named(self):
        self.assertEqual(
            self.about("`quietly-files`"),
            ["shared `quietly-files`: classified not-ingesting, yet it reaches "
             "the ingest helper(s) ['cmd_quietly_files']"])

    def test_the_synthetic_shared_client_raises_exactly_the_mutants_findings(self):
        self.assertEqual(len(self.findings), 5, "\n".join(self.findings))


# ── the per-verb route-and-call-site table ─────────────────────────────────
#
# Every verb the census classifies as filing something (`applies` or `exempt`)
# has a row naming the ingest call sites its handler reaches, split in two:
#
#   * `report` — the sites that file a run's REPORT (the `/api/v2/runs` and
#     `/api/v2/runs/parsed` routes);
#   * `no_report` — the sites that file no report (the synthetic compile
#     ingest a run with no report, or a compile gate, files on
#     `/api/v2/runs/compile`).
#
# A site is `(owner, callee, route)`: the client function holding the call, the
# ingest it calls (`post_ingest`, with its literal route, or the shared ingest,
# whose one route is `/api/v2/runs`). A call of the shared ingest is its own
# call site, whichever client function holds it, so its owner reads `SHARED`.
#
# The table is shaped per client. Every client files every report through
# the shared ingest, and nothing else; what each files beside it is a
# compile ingest, which carries no report.

RUNS_ROUTE = "/api/v2/runs"
PARSED_ROUTE = "/api/v2/runs/parsed"
COMPILE_ROUTE = "/api/v2/runs/compile"
REPORT_ROUTES = (RUNS_ROUTE, PARSED_ROUTE)
SHARED = "<the shared ingest>"


class Routes(NamedTuple):
    report: frozenset
    no_report: frozenset


def routes(report=(), no_report=()):
    return Routes(frozenset(report), frozenset(no_report))


def ingest_sites(source):
    """`{function: {(owner, callee, route)}}` — every ingest call each
    module-level function of `source` holds."""
    found = {}
    for node in ast.parse(source).body:
        if not isinstance(node, ast.FunctionDef):
            continue
        for call in ast.walk(node):
            if not isinstance(call, ast.Call):
                continue
            callee = _callee_name(call)
            if callee == SHARED_INGEST:
                site = (SHARED, SHARED_INGEST, RUNS_ROUTE)
            elif callee == "post_ingest":
                route = (call.args[1].value if len(call.args) >= 2
                         and isinstance(call.args[1], ast.Constant)
                         else "<computed route>")
                site = (node.name, "post_ingest", route)
            else:
                continue
            found.setdefault(node.name, set()).add(site)
    return found


def verb_routes(source, handlers, census):
    """`{verb: Routes}` for every verb `census` classifies as filing
    something, read off the ingest sites its handler reaches."""
    code = ClientSource(source)
    sites = ingest_sites(source)
    table = {}
    for verb, entry in census.items():
        if entry.kind == NOT_INGESTING or verb not in handlers:
            continue
        reached = {site for owner in code.reach(handlers[verb])
                   for site in sites.get(owner, ())}
        table[verb] = routes(
            report={s for s in reached if s[2] in REPORT_ROUTES},
            no_report={s for s in reached if s[2] not in REPORT_ROUTES})
    return table


_THROUGH_THE_SHARED_INGEST = {(SHARED, SHARED_INGEST, RUNS_ROUTE)}
_BUN_COMPILE = {("_ingest_compile", "post_ingest", COMPILE_ROUTE)}
_PY_COMPILE = {("_ingest_compile", "post_ingest", COMPILE_ROUTE)}
_MVN_COMPILE = {("_ingest_compile", "post_ingest", COMPILE_ROUTE)}
_RUST_RUSTC = {("_ingest_rustc_stderr", "post_ingest", COMPILE_ROUTE)}
_ARDUINO_COMPILE = {("_ingest_compile", "post_ingest", COMPILE_ROUTE)}

ROUTE_TABLE = {
    "bun": {
        # `test` with no junit.xml files the synthetic compile ingest: no report.
        "test": routes(_THROUGH_THE_SHARED_INGEST, _BUN_COMPILE),
        "regression": routes(_THROUGH_THE_SHARED_INGEST),
        "unit": routes(_THROUGH_THE_SHARED_INGEST),
        "module": routes(_THROUGH_THE_SHARED_INGEST),
        "integration": routes(_THROUGH_THE_SHARED_INGEST),
        "e2e": routes(_THROUGH_THE_SHARED_INGEST),
        "bdd": routes(_THROUGH_THE_SHARED_INGEST),
        # Its tsc step files a compile ingest: no report.
        "pre-merge-gate": routes(_THROUGH_THE_SHARED_INGEST, _BUN_COMPILE),
        "auto-ingest": routes(_THROUGH_THE_SHARED_INGEST),
        "check": routes((), _BUN_COMPILE),
    },
    "python": {
        # Each suite verb's no-report exit (no JUnit, or pytest failed as a
        # runner) files the synthetic compile ingest: no report.
        **{verb: routes(_THROUGH_THE_SHARED_INGEST, _PY_COMPILE)
           for verb in ("test", "unit", "module", "integration", "e2e",
                        "bdd", "regression", "pre-merge-gate")},
        "auto-ingest": routes(_THROUGH_THE_SHARED_INGEST),
        "check": routes((), _PY_COMPILE),
    },
    "mvn": {
        # Each report verb's no-report exit (no TEST-*.xml) files the compile
        # ingest of `mvn clean test-compile`: no report.
        **{verb: routes(_THROUGH_THE_SHARED_INGEST, _MVN_COMPILE)
           for verb in ("test", "unit", "module", "bdd", "integration", "e2e",
                        "regression", "pre-merge-gate", "auto-ingest")},
        "check": routes((), _MVN_COMPILE),
        "compile": routes((), _MVN_COMPILE),
    },
    "rust": {
        # Each `cargo nextest` verb's no-report exit (no junit.xml) files the
        # rustc compile ingest of `cargo check --tests`: no report.
        **{verb: routes(_THROUGH_THE_SHARED_INGEST, _RUST_RUSTC)
           for verb in ("test", "unit", "integration", "e2e", "module", "bdd")},
        "smoke-test": routes(_THROUGH_THE_SHARED_INGEST),
        "docker-e2e-gate": routes(_THROUGH_THE_SHARED_INGEST),
        "workspace-regression": routes(_THROUGH_THE_SHARED_INGEST),
        "regression": routes(_THROUGH_THE_SHARED_INGEST),
        # The gate's clippy step files a rustc compile ingest: no report. Its
        # declared profiles (`_test_run`) and its whole suite
        # (`_workspace_regression_run`) both file through the shared ingest.
        "pre-merge-gate": routes(_THROUGH_THE_SHARED_INGEST, _RUST_RUSTC),
        "regression-ingest": routes(_THROUGH_THE_SHARED_INGEST),
        # With no junit.xml it runs `cargo check` and files its stderr: no
        # report.
        "auto-ingest": routes(
            _THROUGH_THE_SHARED_INGEST,
            {("cmd_auto_ingest", "post_ingest", COMPILE_ROUTE)}),
        "check": routes((), _RUST_RUSTC),
        "clippy": routes((), _RUST_RUSTC),
        "workspace-clippy": routes((), _RUST_RUSTC),
    },
    "arduino": {
        # Every native `make` verb files its TEST-*.xml through the shared
        # ingest; a run with no report files nothing.
        **{verb: routes(_THROUGH_THE_SHARED_INGEST)
           for verb in ("test", "unit", "regression", "module", "integration",
                        "e2e", "bdd")},
        # The gate's arduino-cli compile step files a compile ingest: no
        # report. Its whole suite files through the shared ingest.
        "pre-merge-gate": routes(_THROUGH_THE_SHARED_INGEST, _ARDUINO_COMPILE),
        "auto-ingest": routes(_THROUGH_THE_SHARED_INGEST),
        "check": routes((), _ARDUINO_COMPILE),
        "compile": routes((), _ARDUINO_COMPILE),
    },
}


def _route_lines(table):
    return "\n".join(
        f"  {verb}: report={sorted(r.report)} no_report={sorted(r.no_report)}"
        for verb, r in sorted(table.items()))


class EveryFilingVerbsRouteAndCallSiteAreTabledTest(unittest.TestCase):
    """The route-and-call-site table, against each real client's source."""

    def assert_client_matches_its_table(self, client):
        actual = verb_routes(_client_source(client), _client_handlers(client),
                             client_census(client))
        expected = ROUTE_TABLE[client]
        self.assertEqual(
            actual, expected,
            f"{client}: the ingest call sites each filing verb reaches.\n"
            f"actual:\n{_route_lines(actual)}\nexpected:\n"
            f"{_route_lines(expected)}")

    def test_every_bun_report_verb_files_through_the_shared_ingest_only(self):
        self.assert_client_matches_its_table("bun")

    def test_every_python_report_verb_files_through_the_shared_ingest_only(self):
        self.assert_client_matches_its_table("python")

    def test_every_mvn_report_verb_files_through_the_shared_ingest_only(self):
        self.assert_client_matches_its_table("mvn")

    def test_every_rust_report_verb_files_through_the_shared_ingest_only(self):
        self.assert_client_matches_its_table("rust")

    def test_every_arduino_report_verb_files_through_the_shared_ingest_only(self):
        self.assert_client_matches_its_table("arduino")

    def test_the_table_has_a_row_for_every_filing_verb_and_no_other(self):
        for client in CLIENT_KEYS:
            census = client_census(client)
            filing = {verb for verb, entry in census.items()
                      if entry.kind != NOT_INGESTING
                      and verb in _client_handlers(client)}
            with self.subTest(client=client):
                self.assertEqual(set(ROUTE_TABLE[client]), filing)

    def test_bun_states_neither_the_parsed_route_nor_a_data_path(self):
        # Docstrings may name the route; no live string may.
        tree = ast.parse(_client_source("bun"))
        docstrings = {id(node.value) for node in ast.walk(tree)
                      if isinstance(node, ast.Expr)
                      and isinstance(node.value, ast.Constant)}
        live = [node.value for node in ast.walk(tree)
                if isinstance(node, ast.Constant) and isinstance(node.value, str)
                and id(node) not in docstrings]
        self.assertEqual(
            [text for text in live if text in (PARSED_ROUTE, "dataPath")], [],
            "the bun client never posts to the parsed route and never sends "
            "a `dataPath`")

    def test_mvn_states_neither_the_parsed_route_nor_a_data_path(self):
        # Docstrings may name the route; no live string may.
        tree = ast.parse(_client_source("mvn"))
        docstrings = {id(node.value) for node in ast.walk(tree)
                      if isinstance(node, ast.Expr)
                      and isinstance(node.value, ast.Constant)}
        live = [node.value for node in ast.walk(tree)
                if isinstance(node, ast.Constant) and isinstance(node.value, str)
                and id(node) not in docstrings]
        self.assertEqual(
            [text for text in live if text in (PARSED_ROUTE, "dataPath")], [],
            "the maven client never posts to the parsed route and never sends "
            "a `dataPath`")

    def test_rust_states_neither_the_parsed_route_nor_a_data_path(self):
        # Docstrings may name the route; no live string may.
        tree = ast.parse(_client_source("rust"))
        docstrings = {id(node.value) for node in ast.walk(tree)
                      if isinstance(node, ast.Expr)
                      and isinstance(node.value, ast.Constant)}
        live = [node.value for node in ast.walk(tree)
                if isinstance(node, ast.Constant) and isinstance(node.value, str)
                and id(node) not in docstrings]
        self.assertEqual(
            [text for text in live if text in (PARSED_ROUTE, "dataPath")], [],
            "the rust client never posts to the parsed route and never sends "
            "a `dataPath`")


_SYNTHETIC_ROUTED_CLIENT = textwrap.dedent('''
    import argparse


    def _axi():
        raise RuntimeError("never run: the table only reads this source")


    def _post(path, payload):
        raise RuntimeError("never run")


    def _get(path):
        raise RuntimeError("never run")


    def _file_compile(text):
        return _axi().post_ingest(_post, "/api/v2/runs/compile", {"e": text},
                                  stack="synthetic")


    def _file_parsed(counts):
        return _axi().post_ingest(_post, "/api/v2/runs/parsed", counts,
                                  stack="synthetic")


    def _shared_body(args):
        if args.nothing:
            return _file_compile("no report")
        return _axi().{shared}(_post, _get, codec="junit", report_paths=[],
                               stack="synthetic", runner_exit=0)


    def cmd_shared(args):
        return _shared_body(args)


    def cmd_parsed(args):
        return _file_parsed({})


    def cmd_compile(args):
        return _file_compile("tsc")


    def cmd_status(args):
        return 0


    def main():
        p = argparse.ArgumentParser()
        sub = p.add_subparsers(dest="cmd", required=True)
        for verb, func in (("shared", cmd_shared), ("parsed", cmd_parsed),
                           ("compile", cmd_compile), ("status", cmd_status)):
            sub.add_parser(verb).set_defaults(func=func)
        args = p.parse_args()
        return args.func(args)
''')


class TheRouteTableIsProvedOnASyntheticClientTest(unittest.TestCase):
    """The table reader, on a synthetic client: a shared-ingest verb with a
    compile no-report exit, a parsed-route verb, a compile gate, and a verb
    that files nothing."""

    @classmethod
    def setUpClass(cls):
        cls.source = _SYNTHETIC_ROUTED_CLIENT.replace("{shared}",
                                                      _shared_ingest_name())
        cls.tmpdir = tempfile.mkdtemp(prefix="route-table-synthetic-")
        path = Path(cls.tmpdir) / "synthetic-routed-crucible.py"
        path.write_text(cls.source)
        handlers = verb_handlers(path, "route_table_synthetic")
        census = {"shared": applies("_shared_body"),
                  "parsed": exempt("files a report on disk"),
                  "compile": exempt("a compile gate"),
                  "status": not_ingesting("reads only")}
        cls.table = verb_routes(cls.source, handlers, census)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmpdir, ignore_errors=True)

    def test_a_shared_ingest_call_is_its_own_call_site_on_the_runs_route(self):
        self.assertEqual(
            self.table["shared"],
            routes({(SHARED, SHARED_INGEST, RUNS_ROUTE)},
                   {("_file_compile", "post_ingest", COMPILE_ROUTE)}))

    def test_a_post_ingest_call_is_read_with_its_owner_and_literal_route(self):
        self.assertEqual(
            self.table["parsed"],
            routes({("_file_parsed", "post_ingest", PARSED_ROUTE)}))

    def test_a_compile_ingest_is_a_no_report_site(self):
        self.assertEqual(
            self.table["compile"],
            routes((), {("_file_compile", "post_ingest", COMPILE_ROUTE)}))

    def test_a_verb_that_files_nothing_has_no_row(self):
        self.assertNotIn("status", self.table)


if __name__ == "__main__":
    unittest.main()
