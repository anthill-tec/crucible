"""CR-CRU-216 §S3/AC5 — `runs` and `run` are registered ONCE for the fleet.

The five clients (`bun`, `python`, `mvn`, `rust`, `arduino`) register both
verbs through ONE shared registrar in `clients/_crucible_axi.py` that takes a
verb → delegator `funcs` mapping (the `add_roadmap_verbs` shape). Each client
defines its own `cmd_runs` and `cmd_run`, thin delegators to the shared bodies,
and builds no `add_parser("runs")` / `add_parser("run")` of its own.

The spec does not name the registrar, so the scan DISCOVERS it: the top-level
function of the shared module whose own `add_parser(...)` calls register
`runs` and `run`. It reads the AST, never a grep — a verb named in a docstring
or a help string is prose, and prose registers nothing.

The scan is proved on SYNTHETIC sources first (`RunReadRegistrationScanProofTest`):
a compliant fleet raises nothing, and each violation it exists to catch is
named for the one client that commits it. Only then is it run over the real
fleet (`TheFleetRegistersRunsAndRunOnceTest`), which is RED today: the shared
module holds no registrar for either verb, and no client defines `cmd_runs` or
`cmd_run`.

Invocation:
    python3 -m unittest tests.client.test_the_run_read_verbs_register_once_for_the_fleet
"""

import ast
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_PATH = CLIENTS_DIR / "_crucible_axi.py"
CLIENT_KEYS = ("bun", "python", "mvn", "rust", "arduino")

RUN_READ_VERBS = ("runs", "run")
DELEGATORS = {"runs": "cmd_runs", "run": "cmd_run"}


def _add_parser_verbs(node):
    """The string literals `node`'s `<x>.add_parser("<verb>", …)` calls
    register, anywhere under it."""
    verbs = set()
    for inner in ast.walk(node):
        if (isinstance(inner, ast.Call)
                and isinstance(inner.func, ast.Attribute)
                and inner.func.attr == "add_parser"
                and inner.args
                and isinstance(inner.args[0], ast.Constant)
                and isinstance(inner.args[0].value, str)):
            verbs.add(inner.args[0].value)
    return verbs


def run_read_registrars(axi_source):
    """`{name: verbs}` for every top-level function of the shared module that
    registers `runs` or `run`."""
    found = {}
    for node in ast.parse(axi_source).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            verbs = _add_parser_verbs(node) & set(RUN_READ_VERBS)
            if verbs:
                found[node.name] = verbs
    return found


def _called_name(call):
    func = call.func
    if isinstance(func, ast.Attribute):
        return func.attr
    return getattr(func, "id", None)


def _reachable_statements(tree):
    """Module-level statements plus `main()`'s own body — where every
    registrar call on the fleet is written, and where one can RUN."""
    statements = list(tree.body)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "main":
            statements.extend(node.body)
    return statements


def _registrar_mapping(tree, registrar):
    """The verb → delegator-name mapping a client hands `registrar`, from the
    dict literal of its reachable call; None when it never calls it."""
    for statement in _reachable_statements(tree):
        if not (isinstance(statement, ast.Expr)
                and isinstance(statement.value, ast.Call)
                and _called_name(statement.value) == registrar):
            continue
        call = statement.value
        mapping = {}
        for arg in list(call.args) + [kw.value for kw in call.keywords]:
            if isinstance(arg, ast.Dict):
                for key, value in zip(arg.keys, arg.values):
                    if isinstance(key, ast.Constant):
                        mapping[key.value] = (value.id if isinstance(value, ast.Name)
                                              else ast.unparse(value))
        return mapping
    return None


def _is_thin_delegator(func):
    body = [s for s in func.body
            if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))]
    return len(body) == 1 and isinstance(body[0], ast.Return)


def run_read_offenders(axi_source, client_sources):
    """AC5's registration rule as a pure function of the sources:
    `{"axi" | client: [finding, …]}`, empty when the fleet complies."""
    offenders = {}
    registrars = run_read_registrars(axi_source)
    complete = [name for name, verbs in registrars.items()
                if verbs == set(RUN_READ_VERBS)]
    if len(registrars) != 1 or len(complete) != 1:
        offenders["axi"] = [
            f"expected ONE shared registrar registering both `runs` and "
            f"`run`; found {dict(sorted((k, sorted(v)) for k, v in registrars.items()))!r}"]
    registrar = complete[0] if len(complete) == 1 else None

    for client, source in client_sources.items():
        findings = []
        tree = ast.parse(source)
        defs = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
        for verb, name in DELEGATORS.items():
            mine = [d for d in defs if d.name == name]
            if not mine:
                findings.append(f"defines no `{name}`")
            elif len(mine) > 1:
                findings.append(f"defines `{name}` {len(mine)} times")
            elif not _is_thin_delegator(mine[0]):
                findings.append(f"`{name}` is not a thin delegator (one "
                                f"`return` over the shared body)")
        forked = sorted(_add_parser_verbs(tree) & set(RUN_READ_VERBS))
        if forked:
            findings.append(f"builds its own add_parser for {forked!r}")
        if registrar is not None:
            mapping = _registrar_mapping(tree, registrar)
            if mapping is None:
                findings.append(f"never calls the shared `{registrar}`")
            else:
                wrong = {verb: mapping.get(verb) for verb in RUN_READ_VERBS
                         if mapping.get(verb) != DELEGATORS[verb]}
                if wrong:
                    findings.append(f"hands `{registrar}` {wrong!r}, not its "
                                    f"own cmd_runs/cmd_run")
        if findings:
            offenders[client] = findings
    return offenders


# ── synthetic sources: the proof that the scan can fire ─────────────────────

SYNTHETIC_AXI = textwrap.dedent('''
    def add_stored_run_verbs(sub, funcs, *, parents=(), add_args=()):
        """Registers the two read verbs."""
        rs = sub.add_parser("runs", parents=list(parents), help="list runs")
        rs.add_argument("--cycle", help="the cycle")
        for adder in add_args:
            adder(rs)
        rs.set_defaults(func=funcs["runs"])
        rn = sub.add_parser("run", parents=list(parents), help="one run")
        rn.set_defaults(func=funcs["run"])

    def cmd_runs(args, project_dir, ops):
        return 0

    def cmd_run(args, project_dir, ops):
        return 0
''')

SYNTHETIC_CLIENT = textwrap.dedent('''
    def cmd_runs(args):
        """Delegates."""
        return _axi().cmd_runs(args, _resolve_project_dir(args.project_dir), _ops())

    def cmd_run(args):
        return _axi().cmd_run(args, _resolve_project_dir(args.project_dir), _ops())

    def main():
        p = argparse.ArgumentParser()
        sub = p.add_subparsers(dest="cmd")
        _axi().add_stored_run_verbs(
            sub, {"runs": cmd_runs, "run": cmd_run},
            add_args=(_add_project_dir_arg,))
        args = p.parse_args()
''')


def _mutate(old, new):
    """`SYNTHETIC_CLIENT` with ONE edit — refused when the edit matched
    nothing, so a mutant can never pass by being the original."""
    assert SYNTHETIC_CLIENT.count(old) == 1, f"mutation anchor not unique: {old!r}"
    return SYNTHETIC_CLIENT.replace(old, new)


def _fleet(**overrides):
    return {client: overrides.get(client, SYNTHETIC_CLIENT)
            for client in CLIENT_KEYS}


class RunReadRegistrationScanProofTest(unittest.TestCase):
    """The scan, on text this test builds: a clean fleet and each violation."""

    def test_a_compliant_synthetic_fleet_raises_nothing(self):
        self.assertEqual(run_read_offenders(SYNTHETIC_AXI, _fleet()), {})

    def test_the_registrar_is_discovered_whatever_it_is_called(self):
        self.assertEqual(run_read_registrars(SYNTHETIC_AXI),
                         {"add_stored_run_verbs": {"runs", "run"}})

    def test_a_shared_module_with_no_registrar_is_named(self):
        offenders = run_read_offenders("def unrelated():\n    return 1\n",
                                       _fleet())
        self.assertEqual(list(offenders), ["axi"], offenders)

    def test_verbs_named_only_in_prose_register_nothing(self):
        prose = ('def add_prose_verbs(sub, funcs):\n'
                 '    """Would call sub.add_parser("runs")."""\n'
                 '    return \'sub.add_parser("run")\'\n')
        self.assertEqual(run_read_registrars(prose), {})
        self.assertIn("axi", run_read_offenders(prose, _fleet()))

    def test_two_registrars_one_verb_each_are_named(self):
        split = textwrap.dedent('''
            def add_runs_verb(sub, func):
                sub.add_parser("runs").set_defaults(func=func)

            def add_run_verb(sub, func):
                sub.add_parser("run").set_defaults(func=func)
        ''')
        offenders = run_read_offenders(split, _fleet())
        self.assertIn("axi", offenders)
        self.assertIn("add_runs_verb", offenders["axi"][0])

    def test_a_client_without_cmd_run_is_named_alone(self):
        mutant = _mutate("def cmd_run(args):", "def cmd_run_elsewhere(args):")
        self.assertEqual(run_read_offenders(SYNTHETIC_AXI, _fleet(mvn=mutant)),
                         {"mvn": ["defines no `cmd_run`"]})

    def test_a_client_that_hand_rolls_the_runs_subparser_is_named(self):
        mutant = _mutate("    args = p.parse_args()",
                         '    sub.add_parser("runs")\n    args = p.parse_args()')
        offenders = run_read_offenders(SYNTHETIC_AXI, _fleet(rust=mutant))
        self.assertEqual(list(offenders), ["rust"], offenders)
        self.assertIn("builds its own add_parser for ['runs']",
                      offenders["rust"])

    def test_a_client_that_never_calls_the_registrar_is_named(self):
        mutant = _mutate("_axi().add_stored_run_verbs(",
                         "_axi().add_something_else(")
        offenders = run_read_offenders(SYNTHETIC_AXI, _fleet(bun=mutant))
        self.assertEqual(offenders,
                         {"bun": ["never calls the shared `add_stored_run_verbs`"]})

    def test_a_registrar_call_parked_in_dead_code_is_not_wiring(self):
        mutant = _mutate("    _axi().add_stored_run_verbs(",
                         "    if False:\n        _axi().add_stored_run_verbs(")
        offenders = run_read_offenders(SYNTHETIC_AXI, _fleet(arduino=mutant))
        self.assertEqual(
            offenders,
            {"arduino": ["never calls the shared `add_stored_run_verbs`"]})

    def test_a_client_wiring_a_verb_to_another_function_is_named(self):
        mutant = _mutate('"run": cmd_run}', '"run": cmd_status}')
        offenders = run_read_offenders(SYNTHETIC_AXI, _fleet(python=mutant))
        self.assertEqual(list(offenders), ["python"], offenders)
        self.assertIn("cmd_status", offenders["python"][0])

    def test_a_delegator_holding_logic_is_named(self):
        mutant = _mutate('    """Delegates."""\n',
                         '    """Delegates."""\n    rows = []\n')
        self.assertEqual(
            run_read_offenders(SYNTHETIC_AXI, _fleet(bun=mutant)),
            {"bun": ["`cmd_runs` is not a thin delegator (one `return` over "
                     "the shared body)"]})


class TheFleetRegistersRunsAndRunOnceTest(unittest.TestCase):
    """The proven scan, over the real shared module and the five clients."""

    def test_the_five_clients_wire_runs_and_run_through_one_shared_registrar(self):
        sources = {client: (CLIENTS_DIR / f"{client}-crucible.py").read_text()
                   for client in CLIENT_KEYS}
        offenders = run_read_offenders(AXI_PATH.read_text(), sources)
        self.assertEqual(
            offenders, {},
            "every client registers `runs` and `run` through the ONE shared "
            "registrar onto its own thin cmd_runs/cmd_run, and builds no "
            f"subparser of its own for either (§S3/AC5): {offenders!r}")


if __name__ == "__main__":
    unittest.main()
