"""CR-CRU-128 — every flag describes itself: the derived flag-help census.

§S1/§S2/§S3 of `docs/changes/CR-CRU-128-every-flag-describes-itself.md`. The
census AST-walks every `add_argument` call carrying an option string across the
five clients and the shared registrar, and asserts that each one declares
`help=`. It is DERIVED from the source, never a pinned list of the 18 offenders
measured today: a flag added tomorrow without help text fails here on the day it
is written.

**The trap this file is shaped around.** Of the 374 option-bearing declarations
measured 2026-09-13, 338 pass a LITERAL `help=`, 18 pass a NON-literal one (a
module constant, a concatenation, an f-string) and 18 pass none at all. Those
last two counts are EQUAL, so a walker that tests `isinstance(node,
ast.Constant)` reports the correct total of 18 from entirely the wrong members
and looks right. Every presence check below therefore asks whether the `help`
KEYWORD is present, never what kind of expression it holds; where §S3 needs the
help TEXT, a non-literal is resolved by importing the module (`_load_module_by_path`,
reused from `test_cr054_verb_surface_lift.py`) and reading the value. The two
mutation tests are the proof that the distinction is real and not merely
intended: they strip a literal help and a non-literal help constant in a copy of
the source and require the census to name BOTH.

Nothing here is a seventh walker's worth of new convention. `CLIENT_FILES`,
`AXI_MODULE_PATH` and `EXPECTED_CLIENT_COUNT` come from
`tests/client/test_client_tier_surface.py`; `_load_module_by_path` comes from
`tests/client/test_cr054_verb_surface_lift.py`; the shrink-only dated exemption
ceiling follows `PRE_CR_ASSERTION_RESIDUE` at
`tests/project-namespace-tripwire.test.ts:504`.

What is RED here and what is a GREEN-GUARD, stated per test, because a suite
that does not say which of its members were born green is a suite whose colour
means nothing (measured on `release/0.2.0`, 2026-09-13):

  RED   `FlagHelpCensusTest.test_every_option_bearing_add_argument_declares_help`
          — 18 declarations carry no `help=` at all. The failure names each as
          `file:line  --flag`.
  RED   `NominatedRequiredAgentWordingTest.
          test_the_six_required_agent_declarations_share_one_byte_identical_help`
          and `..._the_nominated_wording_states_that_the_flag_is_required` — all
          six of §S1's nominated sites hold no help string at all to compare,
          so there is neither one wording nor a statement of requiredness.
  RED   `FlagHelpQualityTest.
          test_a_choiceless_flag_names_the_server_vocabulary_it_draws_on` — NOT
          foreseen by the CR, and reported as an ESCALATION rather than tuned
          away. `--type` is declared in all five clients with no `choices=` and
          its help enumerates FIVE milestone types; `MILESTONE_TYPES` in
          `src/v2.ts` has held SIX since CR-CRU-074 added `release`. §S3.3's
          acceptance criterion is exactly "fails unless its help names that
          vocabulary", so the rule is doing its job on a real, pre-existing
          drift: five help strings teach a vocabulary the server outgrew. The
          CR's non-goals forbid "rewriting the 338 flags that already carry
          some" help, and record a dated exemption ceiling for §S3.4's residue
          but none for §S3.3's — the spec assumed this check was clean. GREEN
          must either add `release` to those five strings (five one-word edits)
          or the CR must grow a §S3.3 residue entry; weakening the rule to the
          subset the fleet happens to name would make it assert nothing.

  GUARD `FlagHelpCensusTest` non-vacuity (client count, per-source flag floors,
          anchor uniqueness, resolver reach) — all pass today. They are the
          bound on the RED above: without them a walker that silently stopped
          reading would report a clean fleet.
  GUARD `FlagHelpCensusWalkerMutationTest` (both) — pass today, and are the only
          proof that the presence check is not a literal check.
  GUARD `FlagHelpCensusTest.
          test_the_partial_help_ceiling_is_exactly_four_and_only_shrinks` and
          the partial half of the resolver-reach guard — four declarations
          resolve only in PART (one shared `--agent` helper, in four clients,
          whose `extra=` is a caller value), and §S3 grades the fragment it can
          read. All four fragments are full sentences today, so nothing is
          mis-graded; the ceiling refuses the FIFTH, which might be a sliver.
  GUARD `PartialHelpDetectorMutationTest` (both) — the bound on that ceiling: a
          resolver that never reported a partial would satisfy it with nothing.
          They build a mostly-runtime help in a throwaway module and require
          the walk to name it and overflow the guard's own arithmetic.
  GUARD `FlagHelpQualityTest`, except the vocabulary check above — no help is
          empty, none is a bare echo of its own flag name, the vocabulary
          parses are non-empty, and the 19 `"If set"` openers on valued flags
          sit exactly at the dated exemption ceiling. §S3.4 is a forward
          guarantee born green by construction; the 20th `"If set"` is what it
          exists to refuse.
  GUARD `UntouchedFlagSignatureTest` — §S1's third AC ("no flag's name, default,
          `required`, `action`, `choices` or behaviour changes") is a pin, not a
          RED: it records the non-`help` keywords of the 18 declarations this CR
          touches and fails if GREEN changes any of them while adding help.

Invocation:
    python3 -m pytest tests/client/test_cr128_flag_help_census.py -q
Fallback:
    python3 tests/client/test_cr128_flag_help_census.py
"""

import ast
import copy
import re
import shutil
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

# Reused, not rebuilt — §S2's own words. The fleet's client table and its
# asserted client COUNT live in one place already.
from test_client_tier_surface import (  # noqa: E402
    AXI_MODULE_PATH,
    CLIENT_FILES,
    EXPECTED_CLIENT_COUNT,
)
from test_cr054_verb_surface_lift import _load_module_by_path  # noqa: E402

TYPES_TS_PATH = REPO_ROOT / "src" / "types.ts"
V2_ROUTES_PATH = REPO_ROOT / "src" / "v2.ts"

# The census walks the five clients AND the shared registrar: a flag routed
# through `_crucible_axi.py` is declared once for the whole fleet, so an
# undescribed one there is five undescribed flags.
CENSUS_SOURCES = dict(CLIENT_FILES)
CENSUS_SOURCES["axi"] = AXI_MODULE_PATH

# Non-vacuity, measured 2026-09-13 on `release/0.2.0`. FLOORS, not pins: a
# source may grow freely, and a fall means a flag was REMOVED and the reading
# must be re-taken deliberately rather than drifting down unnoticed. Without
# them a walker that silently stopped reading a file would report a clean fleet.
FLAG_COUNT_FLOOR = {
    "bun": 56,
    "rust": 113,
    "mvn": 74,
    "python": 62,
    "arduino": 40,
    "axi": 29,
}
FLEET_FLAG_COUNT_FLOOR = 374

# §S1's nomination, anchored on the DECLARATION (client + subparser verb), never
# on a line number: adding `help=` to `python-crucible.py:1524` shifts every
# line below it, so a line-pinned test would rot the moment GREEN ran. These six
# are the `required=True` `--agent` declarations that carry no description --
# `auto-ingest` in four clients, mvn's `pre-merge-gate` and rust's
# `regression-ingest` (re-measured 2026-09-13; the CR spells the last one "one
# gate verb").
NOMINATED_REQUIRED_AGENT_SITES = (
    ("bun", "verb:auto-ingest"),
    ("mvn", "verb:auto-ingest"),
    ("mvn", "verb:pre-merge-gate"),
    ("python", "verb:auto-ingest"),
    ("rust", "verb:auto-ingest"),
    ("rust", "verb:regression-ingest"),
)

# §S1 AC3 — the non-`help` keywords of the 18 declarations this CR touches,
# read 2026-09-13 BEFORE any help text was added. This CR adds description
# only: a name, default, `required`, `action`, `choices` or `nargs` that moves
# while help is being written is a behaviour change smuggled in under a
# documentation patch, and fails here.
UNTOUCHED_KEYWORD_PIN = {
    ("bun", "verb:register", "--source"):
        ("choices=['claude-md', 'package-json', 'git-repo', 'manual']",
         "default='claude-md'"),
    ("bun", "verb:auto-ingest", "--agent"): ("required=True",),
    ("rust", "verb:auto-ingest", "--agent"): ("required=True",),
    ("rust", "verb:regression-ingest", "--agent"): ("required=True",),
    ("rust", "verb:test", "--crate"): ("required=True",),
    ("rust", "verb:check", "--crate"): ("required=True",),
    ("rust", "verb:clippy", "--crate"): ("required=True",),
    ("mvn", "verb:auto-ingest", "--agent"): ("required=True",),
    ("mvn", "verb:docker-up", "--compose-file"): ("default=None",),
    ("mvn", "verb:docker-up", "--no-wait"): ("action='store_true'",),
    ("mvn", "verb:docker-up", "--services"): ("nargs='+'",),
    ("mvn", "verb:docker-up", "--all-services"): ("action='store_true'",),
    ("mvn", "verb:docker-down", "--compose-file"): ("default=None",),
    ("mvn", "verb:pre-merge-gate", "--agent"): ("required=True",),
    ("mvn", "verb:pre-merge-gate", "--compose-file"): ("default=None",),
    ("mvn", "verb:pre-merge-gate", "--goal"): ("default='verify'",),
    ("mvn", "verb:pre-merge-gate", "--coverage-profile"): (),
    ("python", "verb:auto-ingest", "--agent"): ("required=True",),
}

# §S3.4's residue — the `"If set"` openers on flags that take a VALUE, pinned as
# a dated CEILING exactly as `PRE_CR_ASSERTION_RESIDUE` is at
# `tests/project-namespace-tripwire.test.ts:504`: a file may shrink freely, it
# may not grow, and a file ABSENT from this table must be at ZERO. Measured
# 2026-09-13 by this file's own checker: 19 declarations, every one of them
# `--agent`, describing the ingest SIDE-EFFECT ("If set, ingest surefire ...")
# rather than the flag. Repairing them is a CR-CRU-128 non-goal; refusing the
# 20th is the point.
PRE_CR128_IF_SET_RESIDUE = {
    "clients/bun-crucible.py": 3,
    "clients/mvn-crucible.py": 8,
    "clients/python-crucible.py": 3,
    "clients/rust-crucible.py": 5,
}
PRE_CR128_IF_SET_RESIDUE_TOTAL = 19

# §S2's other residue — the declarations whose `help=` expression only PARTIALLY
# resolves, because part of it is a runtime value no static read can supply.
# Four today (measured 2026-09-13 by this file's own resolver): the shared
# `_add_workflow_agent_arg(p, extra="")` helper in four clients, whose help is a
# literal sentence plus the caller's `extra`. §S3's four checks grade the
# fragment the resolver COULD read, so a declaration whose help is mostly
# runtime would satisfy them on a sliver -- a census satisfiable by a sliver is
# not a census. Pinned as a dated CEILING in the same shape as
# `PRE_CR128_IF_SET_RESIDUE` above: a file may shrink freely, it may not grow,
# and a file ABSENT from this table must be at ZERO, so the FIFTH partial fails
# in the file that introduced it.
PRE_CR128_PARTIAL_HELP_RESIDUE = {
    "clients/bun-crucible.py": 1,
    "clients/mvn-crucible.py": 1,
    "clients/python-crucible.py": 1,
    "clients/rust-crucible.py": 1,
}
PRE_CR128_PARTIAL_HELP_RESIDUE_TOTAL = 4

IF_SET_OPENER = "if set"


def _ts_union_members(source, type_name):
    """The quoted members of an `export type X = "a" | "b";` union."""
    match = re.search(r"export type %s\s*=\s*([^;]+);" % re.escape(type_name),
                      source)
    return () if match is None else tuple(re.findall(r'"([^"]+)"',
                                                     match.group(1)))


def _ts_array_members(source, const_name):
    """The quoted members of an `export const X = [...] as const;` array."""
    match = re.search(
        r"export const %s\s*(?::[^=]+)?=\s*\[([^\]]*)\]" % re.escape(const_name),
        source, re.S)
    return () if match is None else tuple(re.findall(r'"([^"]+)"',
                                                     match.group(1)))


def _ts_set_members(source, const_name):
    """The quoted members of a `const X: ReadonlySet<string> = new Set([...])`."""
    match = re.search(
        r"const %s\s*(?::[^=]+)?=\s*new Set\(\[([^\]]*)\]" % re.escape(const_name),
        source, re.S)
    return () if match is None else tuple(re.findall(r'"([^"]+)"',
                                                     match.group(1)))


def _server_vocabularies():
    """§S3.3's closed vocabularies, DERIVED from the server that owns them --
    never hand-typed here. A flag whose value must be one of these and which
    declares no `choices=` has nowhere but its help text to teach them."""
    types_ts = TYPES_TS_PATH.read_text()
    v2_ts = V2_ROUTES_PATH.read_text()
    return {
        "Tier": _ts_union_members(types_ts, "Tier"),
        "CycleKind": _ts_union_members(types_ts, "CycleKind"),
        "AGENT_ROLES": _ts_array_members(types_ts, "AGENT_ROLES"),
        "IDENTITY_SOURCES": _ts_array_members(types_ts, "IDENTITY_SOURCES"),
        "MILESTONE_TYPES": _ts_set_members(v2_ts, "MILESTONE_TYPES"),
    }


# Which declared flag draws on which server-owned vocabulary. Enumerated (§S3:
# "the vocabularies in scope are enumerated ... not guessed"), and each
# enumeration is checked against the server source by
# `FlagHelpQualityTest.test_the_vocabularies_this_census_enforces_are_the_server_s_own`.
VOCABULARY_FLAGS = {
    "--tier": "Tier",
    "--kind": "CycleKind",
    "--cycle-kind": "CycleKind",
    "--role": "AGENT_ROLES",
    "--source": "IDENTITY_SOURCES",
    "--type": "MILESTONE_TYPES",
}


class FlagDecl:
    """One `add_argument` call that declares an OPTION (a positional has no
    `--` string and is out of §S2's scope)."""

    __slots__ = ("source", "path", "label", "line", "flag", "options", "scope",
                 "has_help", "help_node", "help_text", "help_partial",
                 "keywords", "has_action", "has_choices", "required", "node")

    def __init__(self, **kw):
        for name in self.__slots__:
            setattr(self, name, kw.get(name))

    @property
    def anchor(self):
        return (self.source, self.scope, self.flag)

    @property
    def offender_line(self):
        """§S2's required failure shape: `file:line  --flag`."""
        return "%s:%d  %s" % (self.label, self.line, self.flag)


def _resolve_help(node, namespace):
    """The help VALUE behind a `help=` expression, or `None` when nothing in it
    can be read. Returns `(text, partial)`; `partial` is True when part of the
    expression was a runtime value (a helper's `extra=` parameter) that no
    static read can supply.

    §S2: a non-literal is resolved by importing the module and reading the
    constant, which is why `namespace` is the imported module's `vars()`."""
    if isinstance(node, ast.Constant):
        return (node.value, False) if isinstance(node.value, str) else (None, False)
    if isinstance(node, ast.Name):
        value = namespace.get(node.id)
        return (value, False) if isinstance(value, str) else (None, False)
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        value = getattr(namespace.get(node.value.id), node.attr, None)
        return (value, False) if isinstance(value, str) else (None, False)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, left_partial = _resolve_help(node.left, namespace)
        right, right_partial = _resolve_help(node.right, namespace)
        if left is None and right is None:
            return (None, False)
        partial = left is None or right is None or left_partial or right_partial
        return ((left or "") + (right or ""), partial)
    if isinstance(node, ast.JoinedStr):
        chunks = []
        partial = False
        for part in node.values:
            if isinstance(part, ast.Constant) and isinstance(part.value, str):
                chunks.append(part.value)
            else:
                inner = part.value if isinstance(part, ast.FormattedValue) else part
                text, inner_partial = _resolve_help(inner, namespace)
                if text is None:
                    partial = True
                else:
                    chunks.append(text)
                    partial = partial or inner_partial
        return ("".join(chunks), partial) if chunks else (None, False)
    return (None, False)


def _parser_verb_bindings(tree):
    """Every `x = <sub>.add_parser("verb")` in the file, as `var -> [(line,
    verb)]`. The subparser verb is the census's stable ANCHOR: it survives the
    line shifts that adding 18 help strings causes."""
    bindings = {}
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)):
            continue
        func = node.value.func
        if not (isinstance(func, ast.Attribute) and func.attr == "add_parser"):
            continue
        if not node.value.args:
            continue
        first = node.value.args[0]
        if not (isinstance(first, ast.Constant) and isinstance(first.value, str)):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                bindings.setdefault(target.id, []).append((node.lineno, first.value))
    return bindings


def _enclosing_functions(tree):
    """`node -> enclosing FunctionDef` for the whole tree."""
    enclosing = {}
    stack = [(tree, None)]
    while stack:
        node, fn = stack.pop()
        for child in ast.iter_child_nodes(node):
            child_fn = child if isinstance(
                child, (ast.FunctionDef, ast.AsyncFunctionDef)) else fn
            enclosing[child] = fn
            stack.append((child, child_fn))
    return enclosing


def _scope_of(node, receiver, tree, bindings, enclosing):
    """Where a declaration LIVES, as a name that outlives line numbers:
    `verb:<name>` for a flag hung on a subparser, `def:<name>` for one declared
    by a shared helper that takes the parser as a parameter."""
    var = receiver.id if isinstance(receiver, ast.Name) else None
    if var is None:
        return "expr:%s" % type(receiver).__name__
    fn = enclosing.get(node)
    if fn is not None:
        params = {a.arg for a in fn.args.args} | {a.arg for a in fn.args.kwonlyargs}
        if var in params:
            return "def:%s" % fn.name
    verb = None
    for line, name in bindings.get(var, []):
        if line < node.lineno:
            verb = name
    return ("verb:%s" % verb) if verb is not None else ("var:%s" % var)


def walk_flag_declarations(sources=None, resolve_help=True):
    """Every option-bearing `add_argument` in `sources`, DERIVED from the AST.

    `resolve_help=False` skips importing the modules: the presence of the
    `help` KEYWORD is a pure syntax fact, so the mutation tests can walk a
    throwaway copy without executing it."""
    sources = CENSUS_SOURCES if sources is None else sources
    declarations = []
    for source, path in sources.items():
        path = Path(path)
        text = path.read_text()
        tree = ast.parse(text, filename=str(path))
        bindings = _parser_verb_bindings(tree)
        enclosing = _enclosing_functions(tree)
        namespace = {}
        if resolve_help:
            namespace = vars(_load_module_by_path(
                path, "cr128_flag_help_%s" % source))
        try:
            label = str(path.relative_to(REPO_ROOT))
        except ValueError:
            label = str(path)
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "add_argument"):
                continue
            options = tuple(a.value for a in node.args
                            if isinstance(a, ast.Constant)
                            and isinstance(a.value, str)
                            and a.value.startswith("-"))
            if not options:
                continue  # a POSITIONAL -- out of §S2's scope by its own words
            keywords = {kw.arg: kw.value for kw in node.keywords if kw.arg}
            help_node = keywords.get("help")
            help_text, help_partial = (None, False)
            if help_node is not None and resolve_help:
                help_text, help_partial = _resolve_help(help_node, namespace)
            long_options = [o for o in options if o.startswith("--")]
            required = keywords.get("required")
            declarations.append(FlagDecl(
                source=source,
                path=path,
                label=label,
                line=node.lineno,
                flag=(long_options or list(options))[0],
                options=options,
                scope=_scope_of(node, node.func.value, tree, bindings, enclosing),
                has_help="help" in keywords,
                help_node=help_node,
                help_text=help_text,
                help_partial=help_partial,
                keywords=tuple(sorted(
                    "%s=%s" % (kw.arg, ast.unparse(kw.value))
                    for kw in node.keywords if kw.arg and kw.arg != "help")),
                has_action="action" in keywords,
                has_choices="choices" in keywords,
                required=(required.value if isinstance(required, ast.Constant)
                          else (None if required is None else "<expr>")),
                node=node,
            ))
    return declarations


_CENSUS = None


def census():
    """The walk, once per process -- six files parsed and six modules imported
    is not work to repeat for each of a dozen assertions."""
    global _CENSUS
    if _CENSUS is None:
        _CENSUS = walk_flag_declarations()
    return _CENSUS


def undescribed(declarations):
    return [d for d in declarations if not d.has_help]


def partially_resolved(declarations):
    """The declarations whose help expression resolved to a FRAGMENT -- part of
    it was a runtime value. §S3 grades what it can read, so these are the
    declarations graded on less than their whole description."""
    return [d for d in declarations if d.has_help and d.help_partial]


def _partial_help_over_ceiling(declarations, ceiling):
    """The per-FILE overflow of `partially_resolved` against a dated ceiling, as
    the guard's failure lines. A module function, not a method, so the mutation
    test below exercises the guard's own arithmetic instead of a copy of it."""
    partial = partially_resolved(declarations)
    found = Counter(d.label for d in partial)
    over = []
    for label, count in sorted(found.items()):
        allowed = ceiling.get(label, 0)
        if count > allowed:
            names = [d.offender_line for d in partial if d.label == label]
            over.append("%s: %d > ceiling %d\n%s"
                        % (label, count, allowed, "\n".join(names)))
    return over


def _offender_report(declarations):
    return "\n".join("  " + d.offender_line for d in declarations)


class FlagHelpCensusTest(unittest.TestCase):
    """§S2 — the derived census, and the non-vacuity bounds that stop it
    passing for the wrong reason."""

    def test_every_option_bearing_add_argument_declares_help(self):
        """RED (18 offenders today). §S2's first AC: presence of the `help=`
        KEYWORD, whatever expression it holds -- a module constant, a
        concatenation and an f-string are all DESCRIBED."""
        offenders = undescribed(census())
        self.assertEqual(
            [], [d.offender_line for d in offenders],
            "%d option-bearing add_argument declaration(s) carry no help=:\n%s"
            % (len(offenders), _offender_report(offenders)))

    def test_the_census_reaches_every_client_and_the_shared_registrar(self):
        """GUARD. The bound on the test above: a walker that silently stopped
        reading reports a clean fleet, which is indistinguishable from a
        described one until the counts are asserted."""
        self.assertEqual(EXPECTED_CLIENT_COUNT, len(CLIENT_FILES))
        self.assertEqual(EXPECTED_CLIENT_COUNT + 1, len(CENSUS_SOURCES),
                         "the census walks the five clients AND the shared "
                         "registrar; a missing source is a blind spot")
        found = Counter(d.source for d in census())
        self.assertEqual(set(FLAG_COUNT_FLOOR), set(CENSUS_SOURCES))
        for source, floor in sorted(FLAG_COUNT_FLOOR.items()):
            self.assertGreaterEqual(
                found[source], floor,
                "%s: the walk found %d option-bearing declarations, below the "
                "2026-09-13 floor of %d -- either flags were removed or the "
                "walker stopped seeing them" % (source, found[source], floor))
        self.assertGreaterEqual(sum(found.values()), FLEET_FLAG_COUNT_FLOOR)

    def test_every_declaration_has_a_unique_line_free_anchor(self):
        """GUARD. The pins in this file key on (source, scope, flag) precisely
        because adding help shifts every line below it. That anchor is only
        usable while it stays unique."""
        duplicates = [anchor for anchor, count
                      in Counter(d.anchor for d in census()).items() if count > 1]
        self.assertEqual(
            [], duplicates,
            "anchor collisions make the CR-CRU-128 pins ambiguous: %r"
            % (duplicates,))

    def test_every_declared_help_expression_resolves_to_text(self):
        """GUARD. §S3's four checks read the help TEXT, so a help expression the
        resolver cannot read is a silently unchecked flag, not a passing one --
        and one it can only PARTLY read is a flag graded on a fragment, which is
        the same hole with a smaller mouth. Nothing may be unreadable; the four
        partials are exempt by FILE COUNT, so the fifth fails."""
        unreadable = [d for d in census() if d.has_help and d.help_text is None]
        self.assertEqual(
            [], [d.offender_line for d in unreadable],
            "the help resolver could not read %d declaration(s); every §S3 "
            "check below would skip them" % len(unreadable))
        over = _partial_help_over_ceiling(census(),
                                          PRE_CR128_PARTIAL_HELP_RESIDUE)
        self.assertEqual(
            [], over,
            "a help= expression resolved only in PART -- §S3 would grade the "
            "fragment as if it were the whole description -- beyond the "
            "2026-09-13 ceiling:\n%s" % "\n".join(over))

    def test_the_partial_help_ceiling_is_exactly_four_and_only_shrinks(self):
        """GUARD. The ceiling above is a CEILING: every file may shrink freely,
        none may grow, and a file absent from the table must be at zero. The
        four are one shared `--agent` helper whose `extra=` is a caller value;
        each already resolves to a full sentence, so §S3 grades real text
        today. That is the reading being pinned, not a permission."""
        self.assertEqual(PRE_CR128_PARTIAL_HELP_RESIDUE_TOTAL,
                         sum(PRE_CR128_PARTIAL_HELP_RESIDUE.values()))
        self.assertEqual(4, PRE_CR128_PARTIAL_HELP_RESIDUE_TOTAL)
        partial = partially_resolved(census())
        self.assertLessEqual(
            len(partial), PRE_CR128_PARTIAL_HELP_RESIDUE_TOTAL,
            "the fleet holds %d partially-resolved help expression(s) against "
            "a ceiling of %d:\n%s" % (len(partial),
                                      PRE_CR128_PARTIAL_HELP_RESIDUE_TOTAL,
                                      _offender_report(partial)))
        found = Counter(d.label for d in partial)
        for label in sorted(PRE_CR128_PARTIAL_HELP_RESIDUE):
            self.assertIn(label, CENSUS_SOURCES_BY_LABEL,
                          "the ceiling names a file the census does not walk")
            self.assertLessEqual(found[label],
                                 PRE_CR128_PARTIAL_HELP_RESIDUE[label])
        for decl in partial:
            self.assertTrue(
                decl.help_text and decl.help_text.strip(),
                "%s resolves to nothing readable at all; §S3 would grade the "
                "empty string" % decl.offender_line)


class FlagHelpCensusWalkerMutationTest(unittest.TestCase):
    """GUARD (both). §S2's risk in the CR's own words: 18 declarations pass a
    NON-literal `help=` -- exactly the count of real offenders -- so a walker
    that conflates "no help=" with "help is not a literal" produces the right
    total from the wrong members. These two tests strip a literal help and a
    non-literal help CONSTANT from a throwaway copy and require the census to
    name both; a `isinstance(..., ast.Constant)` walker fails the second."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cr128-mutation-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def _mutated_copy(self, source, pick):
        """A copy of `source` with the `help=` keyword removed from the first
        declaration `pick` selects, plus that declaration as it stood."""
        original = Path(CENSUS_SOURCES[source])
        copy_path = self.tmp / original.name
        shutil.copyfile(original, copy_path)
        sources = {source: copy_path}
        target = next(d for d in walk_flag_declarations(sources, resolve_help=False)
                      if pick(d))
        text = copy_path.read_text()
        lines = text.splitlines(keepends=True)
        start, end = target.node.lineno - 1, target.node.end_lineno - 1
        self.assertEqual(
            "", lines[end][target.node.end_col_offset:].strip(),
            "the mutation splices whole statements; %s is not one"
            % target.offender_line)
        stripped = copy.deepcopy(target.node)
        stripped.keywords = [kw for kw in stripped.keywords if kw.arg != "help"]
        indent = lines[start][:target.node.col_offset]
        lines[start:end + 1] = [indent + ast.unparse(stripped) + "\n"]
        copy_path.write_text("".join(lines))
        return sources, target

    def _new_offenders(self, sources, before):
        after = undescribed(walk_flag_declarations(sources, resolve_help=False))
        seen = {(d.scope, d.flag) for d in before}
        return [d for d in after if (d.scope, d.flag) not in seen]

    def test_stripping_a_literal_help_turns_the_census_red_naming_that_flag(self):
        before = undescribed(walk_flag_declarations(
            {"bun": CENSUS_SOURCES["bun"]}, resolve_help=False))
        sources, target = self._mutated_copy(
            "bun", lambda d: isinstance(d.help_node, ast.Constant))
        new = self._new_offenders(sources, before)
        self.assertEqual([(target.scope, target.flag)],
                         [(d.scope, d.flag) for d in new],
                         "stripping a literal help= must add exactly that one "
                         "offender")
        self.assertRegex(_offender_report(new),
                         r"bun-crucible\.py:\d+  %s" % re.escape(target.flag))

    def test_stripping_a_non_literal_help_constant_turns_the_census_red(self):
        before = undescribed(walk_flag_declarations(
            {"axi": CENSUS_SOURCES["axi"]}, resolve_help=False))
        sources, target = self._mutated_copy(
            "axi", lambda d: isinstance(d.help_node, ast.Name))
        new = self._new_offenders(sources, before)
        self.assertEqual([(target.scope, target.flag)],
                         [(d.scope, d.flag) for d in new],
                         "stripping a help= that held a module CONSTANT must "
                         "add exactly that one offender -- and, before the "
                         "strip, that declaration must not have been an "
                         "offender at all")
        self.assertRegex(_offender_report(new),
                         r"_crucible_axi\.py:\d+  %s" % re.escape(target.flag))


# A declaration whose help is MOSTLY runtime, in the exact shape the fleet's
# four real partials take: a shared helper appends a caller-supplied `extra`.
# Written to a throwaway module and walked with resolution ON, because the
# partial flag is only observable when the resolver actually runs.
_PARTIAL_MUTANT_SOURCE = '''
import argparse

PREFIX = "Sets "


def _add_mostly_runtime(p, extra=""):
    p.add_argument("--mostly-runtime", help=PREFIX + extra)


def _add_interpolated(p, extra=""):
    p.add_argument("--interpolated", help=f"Selects {extra} for the run.")


def build():
    p = argparse.ArgumentParser()
    p.add_argument("--whole", help="Reads the report and ingests it.")
    _add_mostly_runtime(p, extra="whatever the caller decides at runtime.")
    _add_interpolated(p, extra="a value only the caller knows")
    return p
'''


class PartialHelpDetectorMutationTest(unittest.TestCase):
    """GUARD on the partial-help ceiling. "At most four partially-resolved
    declarations" is satisfiable by a resolver that never reports one, and the
    fleet's four real partials each resolve to a full sentence, so nothing in
    the census would notice the difference. This builds a declaration whose
    help is MOSTLY runtime -- a two-word literal plus the caller's `extra`, and
    an f-string whose interpolation is a parameter -- and requires the walk to
    mark both partial, name them, leave the whole-literal flag beside them
    alone, and overflow the ceiling arithmetic the guard itself uses."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cr128-partial-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = self.tmp / "cr128_partial_mutant.py"
        self.path.write_text(_PARTIAL_MUTANT_SOURCE)
        self.label = str(self.path)
        self.walk = walk_flag_declarations({"mutant": self.path})

    def test_a_mostly_runtime_help_is_marked_partial_and_named(self):
        self.assertEqual(
            ["--interpolated", "--mostly-runtime"],
            sorted(d.flag for d in partially_resolved(self.walk)),
            "the resolver read a runtime value as if it were whole text:\n%s"
            % _offender_report(self.walk))
        whole = next(d for d in self.walk if d.flag == "--whole")
        self.assertFalse(whole.help_partial,
                         "a fully literal help must not be called partial, or "
                         "the ceiling counts everything and bounds nothing")
        self.assertEqual("Sets ",
                         next(d for d in self.walk
                              if d.flag == "--mostly-runtime").help_text,
                         "the fragment §S3 would otherwise have graded")

    def test_the_next_partial_overflows_the_ceiling_naming_its_file(self):
        """The FIFTH partial, in miniature: a file already AT its ceiling gets
        one more, and the guard's own arithmetic reports it."""
        self.assertEqual(
            [], _partial_help_over_ceiling(self.walk, {self.label: 2}),
            "two partials against a ceiling of two is not an overflow")
        over = _partial_help_over_ceiling(self.walk, {self.label: 1})
        self.assertEqual(1, len(over),
                         "one file overflowed, so one entry: %r" % (over,))
        self.assertIn("%s: 2 > ceiling 1" % self.label, over[0])
        self.assertRegex(over[0],
                         r"cr128_partial_mutant\.py:\d+  --mostly-runtime")
        self.assertEqual(
            1, len(_partial_help_over_ceiling(self.walk, {})),
            "a file ABSENT from the ceiling table must be held at zero")


class NominatedRequiredAgentWordingTest(unittest.TestCase):
    """§S1's second AC — the six `required=True` `--agent` declarations carry
    ONE byte-identical nominated wording, and that wording says the flag is
    required. `--agent`'s 60 fleet declarations carry 24 distinct help values
    (measured 2026-09-13), so there is no existing description to reuse: the CR
    nominates one and applies it here."""

    def _sites(self):
        by_anchor = {}
        for decl in census():
            if decl.flag == "--agent":
                by_anchor.setdefault((decl.source, decl.scope), []).append(decl)
        return by_anchor

    def test_each_nominated_site_is_one_required_agent_declaration(self):
        """GUARD. Without it, "all six share one wording" is satisfiable by a
        lookup that found none of them."""
        by_anchor = self._sites()
        for anchor in NOMINATED_REQUIRED_AGENT_SITES:
            found = by_anchor.get(anchor, [])
            self.assertEqual(1, len(found),
                             "%r must resolve to exactly one --agent "
                             "declaration, found %d" % (anchor, len(found)))
            self.assertIs(True, found[0].required,
                          "%r is one of §S1's `required=True` sites" % (anchor,))
        self.assertEqual(6, len(NOMINATED_REQUIRED_AGENT_SITES))

    def test_the_six_required_agent_declarations_share_one_byte_identical_help(self):
        """RED. All six hold no help string at all today -- they are six of
        §S1's 18, so there is not even a set of wordings to disagree."""
        by_anchor = self._sites()
        wordings = {}
        for anchor in NOMINATED_REQUIRED_AGENT_SITES:
            found = by_anchor.get(anchor, [])
            wordings[anchor] = found[0].help_text if found else None
        self.assertNotIn(
            None, wordings.values(),
            "these §S1 sites declare no help at all: %r"
            % sorted(a for a, w in wordings.items() if w is None))
        self.assertEqual(
            1, len(set(wordings.values())),
            "§S1 nominates ONE wording for all six sites; found %d distinct: %r"
            % (len(set(wordings.values())), wordings))

    def test_the_nominated_wording_states_that_the_flag_is_required(self):
        """RED. A mandatory flag whose description does not say so is the worst
        case in the set: the agent cannot learn that it is required from the
        surface it is meant to read."""
        by_anchor = self._sites()
        silent = []
        for anchor in NOMINATED_REQUIRED_AGENT_SITES:
            found = by_anchor.get(anchor, [])
            text = found[0].help_text if found else None
            if not text or "required" not in text.lower():
                silent.append("%s %s" % (anchor, text))
        self.assertEqual([], silent,
                         "%d of §S1's six sites do not state that --agent is "
                         "required: %r" % (len(silent), silent))


class FlagHelpQualityTest(unittest.TestCase):
    """§S3 — presence is not usefulness. Four MECHANICAL properties; this CR
    deliberately does not grade prose, and says so."""

    def _described(self):
        return [d for d in census() if d.has_help and d.help_text is not None]

    def test_no_declared_help_text_is_empty(self):
        """GUARD (§S3.1)."""
        empty = [d.offender_line for d in self._described()
                 if not d.help_text.strip()]
        self.assertEqual([], empty, "help= present but empty: %r" % (empty,))

    def test_no_declared_help_text_is_a_bare_echo_of_its_own_flag_name(self):
        """GUARD (§S3.2). `--no-wait` described as "no wait" teaches nothing the
        flag's own spelling did not."""
        def squash(text):
            return re.sub(r"[^a-z0-9]", "", text.lower())

        echoes = [d.offender_line for d in self._described()
                  if squash(d.help_text) and squash(d.help_text) == squash(d.flag)]
        self.assertEqual([], echoes,
                         "help= repeats the flag's own name: %r" % (echoes,))

    def test_the_vocabularies_this_census_enforces_are_the_servers_own(self):
        """GUARD. The bound on the check below: comparing help text against an
        EMPTY parse would pass every flag. Each vocabulary is read out of the
        server source that owns it, so a value added there lands here."""
        vocabularies = _server_vocabularies()
        for name, members in sorted(vocabularies.items()):
            self.assertGreaterEqual(
                len(members), 2,
                "%s parsed as %r -- the server source moved and this census is "
                "now comparing against nothing" % (name, members))
        self.assertEqual(set(VOCABULARY_FLAGS.values()) - set(vocabularies),
                         set(), "a flag is mapped to an unknown vocabulary")
        self.assertEqual(
            ("unit", "module", "integration", "e2e", "regression", "bdd"),
            vocabularies["Tier"])
        self.assertEqual(("red-green", "verify", "fix"),
                         vocabularies["CycleKind"])
        self.assertIn("release", vocabularies["MILESTONE_TYPES"],
                      "CR-CRU-074 added `release` to the accepted milestone "
                      "types; a parse that misses it would make the check "
                      "below pass on the five clients that never learned it")

    def test_a_choiceless_flag_names_the_server_vocabulary_it_draws_on(self):
        """RED (5 offenders today -- see the ESCALATION in the module
        docstring). A flag WITHOUT `choices=` has nowhere else to teach its
        values: argparse will not print them, and the server's refusal is the
        only other teacher. Naming SOME of the vocabulary is what a stale help
        string looks like, so the check requires all of it."""
        vocabularies = _server_vocabularies()
        offenders = []
        checked = 0
        for decl in self._described():
            name = VOCABULARY_FLAGS.get(decl.flag)
            if name is None or decl.has_choices:
                continue
            checked += 1
            missing = [m for m in vocabularies[name] if m not in decl.help_text]
            if missing:
                offenders.append("%s (missing %r)" % (decl.offender_line, missing))
        self.assertEqual(
            [], offenders,
            "%d choice-less flag(s) draw on a closed server vocabulary their "
            "help does not name: %s" % (len(offenders), "\n".join(offenders)))
        self.assertGreaterEqual(
            checked, 3,
            "the check reached %d declaration(s); measured 2026-09-13 it "
            "reaches 7 (--kind, --cycle-kind and five --type)" % checked)

    def test_no_valued_flag_opens_its_help_with_if_set_beyond_the_ceiling(self):
        """GUARD (§S3.4). A flag with no `action=` takes a VALUE, so "If set"
        describes a switch it is not. The 19 existing offenders are exempt by
        FILE COUNT, so the 20th fails in the file that introduced it."""
        offenders = [d for d in self._described()
                     if not d.has_action
                     and d.help_text.strip().lower().startswith(IF_SET_OPENER)]
        found = Counter(d.label for d in offenders)
        over = []
        for label, count in sorted(found.items()):
            ceiling = PRE_CR128_IF_SET_RESIDUE.get(label, 0)
            if count > ceiling:
                names = [d.offender_line for d in offenders if d.label == label]
                over.append("%s: %d > ceiling %d\n%s"
                            % (label, count, ceiling, "\n".join(names)))
        self.assertEqual(
            [], over,
            "a valued flag (no action=) opened its help with \"If set\" beyond "
            "the 2026-09-13 ceiling:\n%s" % "\n".join(over))

    def test_the_if_set_exemption_ceiling_is_exactly_nineteen_and_only_shrinks(self):
        """GUARD. The ceiling is a CEILING: every file may shrink freely, none
        may grow, and a file absent from the table must be at zero."""
        self.assertEqual(PRE_CR128_IF_SET_RESIDUE_TOTAL,
                         sum(PRE_CR128_IF_SET_RESIDUE.values()))
        self.assertEqual(19, PRE_CR128_IF_SET_RESIDUE_TOTAL)
        offenders = [d for d in self._described()
                     if not d.has_action
                     and d.help_text.strip().lower().startswith(IF_SET_OPENER)]
        self.assertLessEqual(
            len(offenders), PRE_CR128_IF_SET_RESIDUE_TOTAL,
            "the fleet holds %d \"If set\" valued flags against a ceiling of "
            "%d" % (len(offenders), PRE_CR128_IF_SET_RESIDUE_TOTAL))
        found = Counter(d.label for d in offenders)
        for label in sorted(PRE_CR128_IF_SET_RESIDUE):
            self.assertIn(label, CENSUS_SOURCES_BY_LABEL,
                          "the ceiling names a file the census does not walk")
            self.assertLessEqual(found[label], PRE_CR128_IF_SET_RESIDUE[label])


CENSUS_SOURCES_BY_LABEL = {
    str(Path(path).relative_to(REPO_ROOT)): source
    for source, path in CENSUS_SOURCES.items()
}


class UntouchedFlagSignatureTest(unittest.TestCase):
    """§S1's third AC — "no flag's name, default, `required`, `action`,
    `choices` or behaviour changes". A PIN, born green: it records what the 18
    touched declarations looked like before CR-CRU-128 and fails if GREEN moves
    anything but the description."""

    def test_the_touched_declarations_keep_their_non_help_keywords(self):
        by_anchor = {d.anchor: d for d in census()}
        drift = []
        for anchor, expected in sorted(UNTOUCHED_KEYWORD_PIN.items()):
            decl = by_anchor.get(anchor)
            if decl is None:
                drift.append("%r: the declaration is gone" % (anchor,))
                continue
            if decl.keywords != tuple(expected):
                drift.append("%s: %r -> %r"
                             % (decl.offender_line, expected, decl.keywords))
        self.assertEqual(
            [], drift,
            "CR-CRU-128 adds DESCRIPTION only; these declarations changed "
            "behaviour too:\n%s" % "\n".join(drift))

    def test_the_pin_covers_every_declaration_this_cr_touches(self):
        """GUARD. 18 offenders were measured 2026-09-13; the pin must hold all
        18, or it silently permits a behaviour change on the ones it omits."""
        self.assertEqual(18, len(UNTOUCHED_KEYWORD_PIN))


if __name__ == "__main__":
    unittest.main(verbosity=2)
