"""CR-CRU-139 §S1b / C2 -- no file under `tests/` STEERS a client or a server
through one of the four retired environment variables.

── The contract ──────────────────────────────────────────────────────

`$CRUCIBLE_PORT`, `$CRUCIBLE_HOST` (§S1, retired in C1) and `$CRUCIBLE_URL`,
`$CRUCIBLE_BASE` (§S2, retired here) are not read by anything any more. A
fixture that still EXPORTS one to point a client or a server somewhere is a
fixture steering through a channel the product no longer has: it does not
fail, it silently stops steering, and the drive lands on the SHIPPED default
-- `http://localhost:3849` for a client, port 3849 for a server -- which on
the two-instance workstation this CR serves is the PRODUCTION board. That is
the precise accident §S2 exists to make impossible, and a suite is not exempt
from it.

The replacement is stronger than the export in every case and §S1b names all
three: `startServer({ port })` in-process, a `[server]` table in the temp
store dir for a server spawned as a subprocess, and a `[client] url` table in
the temp project (or install) root for a client. Each of those exercises the
REAL resolution path, so the fixture proves the mechanism operators use rather
than a bypass only tests can reach.

── What counts as STEERING, and what deliberately does not ──────────────

The subject is an ASSIGNMENT of a retired name to a value a drive would then
obey. Three things that mention a retired name are NOT that, and the detector
must keep passing them or this guard would forbid the very assertions that
prove the variables are dead:

  * a REMOVAL -- `env[...] = None`, `os.environ.pop(...)`, the `ENV_KEYS`
    hygiene tuples, `delete process.env....`. §S1b's own measurement excludes
    these explicitly: they are not setters and they do not migrate.
  * PROSE -- a comment or docstring naming a retired variable. This file is
    itself full of them.
  * a name used as DATA -- `SERVER_PORT_ENV_VAR = "CRUCIBLE_PORT"` followed by
    an `assertNotIn` against a systemd unit's text. The string is the subject
    of the assertion, not a channel being used.

One narrow class of setter survives, in an allow-list carrying a REASON per
file: a test that exports a retired variable to JUNK precisely to prove that
exporting it changes nothing. Deleting those would delete the proof that the
retirement happened. The allow-list is asserted to be small, and every path in
it is asserted to exist, so it cannot rot into a blanket exemption.

── Why a detector rather than a grep ────────────────────────────────

Measured 2026-09-17 at HEAD, `tests/` mentions the four names 456 times, and
the large majority are the three exempt classes above. A text guard would
either flag those (forbidding C1's own deadness proofs) or be loosened until it
flagged nothing. So the python half is an AST pass over the real syntax of an
assignment -- subscript store, dict entry, keyword argument, `setdefault` --
with ONE level of name indirection resolved, because `env[SERVER_PORT_ENV_VAR]
= port` is the same steering spelled through a constant. The TypeScript half is
a line scan over the three shapes a bun suite can steer with (`process.env.X =`,
an `env: { X: ... }` entry, an `X=...` word in a shell command string), with
comment lines dropped.

A detector that can see nothing passes vacuously, so the first test in this
file feeds it both a positive and a negative control before any real file is
read.

── HOW THIS FAILS IF THE CODE DOES NOTHING ──────────────────────────

RED today: `tests/` carries dozens of real steering sites -- the fleet census
hands every drive `CRUCIBLE_URL`/`CRUCIBLE_BASE` (`drive_verb`), the gate
suites export the stub board's URL into `os.environ`, and several bun suites
pass `CRUCIBLE_PORT` to a spawned server. Every one is reported with its
`file:line` and the name it set.

Invocation:
    python3 -m unittest tests.client.test_no_test_steers_a_client_by_a_retired_variable -v
What CI runs (and what must list these ids):
    python3 -m unittest discover -s tests/client -t .
"""

import ast
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TESTS_DIR = REPO_ROOT / "tests"

#: §S1 (C1) retired the first pair, §S2 (C2) the second. One list, because the
#: hazard is identical: a channel nothing reads, still being aimed.
RETIRED_VARIABLES = ("CRUCIBLE_PORT", "CRUCIBLE_HOST",
                     "CRUCIBLE_URL", "CRUCIBLE_BASE")

#: The two that STAY environment-resolved (§S3) -- named here so a reader of a
#: failure can see the line this guard does NOT draw. They precede
#: configuration discovery: the store path is how the server finds its file,
#: the project key is identity read from the project `.env`.
ENVIRONMENT_RESOLVED_STILL = ("CRUCIBLE_DB", "CRUCIBLE_PROJECT_KEY")

#: The narrow exemption: a suite whose SUBJECT is that exporting a retired
#: variable changes nothing. Each entry states why, because an allow-list
#: without a reason becomes a place to put anything inconvenient.
DEADNESS_PROOFS = {
    "tests/client/test_cr066_serve_and_target_dir.py":
        "§S1b re-subject -- exports junk CRUCIBLE_HOST/PORT to prove `serve` "
        "composes no listener environment and the child listens per its own "
        "file.",
    "tests/client/test_cr070_systemd_unit.py":
        "§S1b re-subject -- exports junk CRUCIBLE_HOST/PORT to prove the unit "
        "forwards the store and nothing else.",
    "tests/server-listener-is-configuration.test.ts":
        "§S1 (C1) deadness proof -- boots a server with junk CRUCIBLE_PORT/HOST "
        "exported and asserts it listens per its file, and that nothing bound "
        "the retired address.",
    "tests/client/test_a_clients_board_is_its_projects_configuration.py":
        "C2 criterion 3 -- exports junk CRUCIBLE_URL/CRUCIBLE_BASE to prove "
        "the pair is dead and the project's file still decides.",
}

_PY_SUFFIXES = (".py",)
_TS_SUFFIXES = (".ts", ".tsx", ".mts")

#: The three shapes a TypeScript suite can steer with. `undefined` on the
#: right-hand side is a REMOVAL, filtered below beside python's `None`.
_TS_SETTERS = (
    re.compile(r"process\.env\.(?P<name>" + "|".join(RETIRED_VARIABLES)
               + r")\s*=(?!=)\s*(?P<value>.*)$"),
    re.compile(r"[\"']?(?P<name>" + "|".join(RETIRED_VARIABLES)
               + r")[\"']?\s*:\s*(?P<value>[^,}]+)"),
    re.compile(r"(?<![\w.])(?P<name>" + "|".join(RETIRED_VARIABLES)
               + r")=(?P<value>\S+)"),
)

_TS_COMMENT = re.compile(r"^\s*(//|/\*|\*)")
_TS_REMOVAL = re.compile(r"^\s*(undefined|null)\b")

#: A retired name inside a MATCHER is the subject of an assertion, not a
#: channel: `expect(commands.some((l) => /^CRUCIBLE_PORT=\S+ crucible-axi
#: serve/.test(l)))` is a RUNBOOK documentation guard, and reading it as a
#: steering site would demand that C4's doc rule be deleted rather than moved.
#: Applied ONLY to the bare `NAME=value` shell shape -- the other two shapes
#: are assignment syntax that cannot occur inside a regex literal.
_TS_MATCHER = re.compile(r"expect\(|/\^|\.test\(|toMatch|assert")


class _Setter:
    """One steering site: where it is, which variable it aimed, and the shape
    it used. Every failure message is built from these, because the person
    reading it has to go and change the line."""

    __slots__ = ("path", "line", "name", "shape")

    def __init__(self, path, line, name, shape):
        self.path = path
        self.line = line
        self.name = name
        self.shape = shape

    def __repr__(self):
        return f"{self.path}:{self.line} sets {self.name} ({self.shape})"


def _is_removal(node):
    """`None` on the right-hand side removes a variable rather than aiming it
    -- the shape every `_patched_env` hygiene tuple in this suite uses."""
    return isinstance(node, ast.Constant) and node.value is None


def _literal_retired(node):
    if (isinstance(node, ast.Constant) and isinstance(node.value, str)
            and node.value in RETIRED_VARIABLES):
        return node.value
    return None


def _indirection_map(tree):
    """Module-level `NAME = "CRUCIBLE_PORT"` bindings.

    `env[SERVER_PORT_ENV_VAR] = port` is the same steering as
    `env["CRUCIBLE_PORT"] = port`, and two suites in this directory really do
    spell it that way. One level is enough: nothing in `tests/` chains the
    indirection, and a guard that tried to constant-fold arbitrarily would be
    asserting about an interpreter it does not have."""
    bindings = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        literal = _literal_retired(node.value)
        if literal is None:
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                bindings[target.id] = literal
    return bindings


def python_setters(source, path, filename="<source>"):
    """Every retired-variable ASSIGNMENT in `source`, as `_Setter` rows.

    Four shapes, which are all the ways a python fixture aims an environment
    variable: a subscript store (`os.environ[...] = v`, `env[...] = v`), a dict
    entry (`{...: v}` handed to `patch.dict`/`subprocess.run(env=...)`), a
    keyword argument (`_patched_env(CRUCIBLE_HOST=v)`) and `setdefault`.
    """
    tree = ast.parse(source, filename=filename)
    names = _indirection_map(tree)

    def retired(node):
        literal = _literal_retired(node)
        if literal is not None:
            return literal
        if isinstance(node, ast.Name):
            return names.get(node.id)
        return None

    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Subscript):
                    name = retired(target.slice)
                    if name and not _is_removal(node.value):
                        found.append(_Setter(path, target.lineno, name,
                                             "subscript store"))
        elif isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if key is None:
                    continue
                name = retired(key)
                if name and not _is_removal(value):
                    found.append(_Setter(path, key.lineno, name,
                                         "dict entry"))
        elif isinstance(node, ast.Call):
            for keyword in node.keywords:
                if (keyword.arg in RETIRED_VARIABLES
                        and not _is_removal(keyword.value)):
                    found.append(_Setter(path, keyword.value.lineno,
                                         keyword.arg, "keyword argument"))
            func = node.func
            if (isinstance(func, ast.Attribute) and func.attr == "setdefault"
                    and node.args):
                name = retired(node.args[0])
                if name and not (len(node.args) > 1
                                 and _is_removal(node.args[1])):
                    found.append(_Setter(path, node.lineno, name,
                                         "setdefault"))
    return sorted(found, key=lambda s: (s.line, s.name, s.shape))


def typescript_setters(source, path):
    """Every retired-variable assignment in a `.ts` source, by line scan.

    Comment lines are dropped first: the bun suites discuss the retired
    variables at length (C1 left the reasoning in place beside the code it
    changed), and prose is not a channel.
    """
    found = []
    for number, line in enumerate(source.splitlines(), start=1):
        if _TS_COMMENT.match(line):
            continue
        for index, pattern in enumerate(_TS_SETTERS):
            match = pattern.search(line)
            if match is None:
                continue
            if _TS_REMOVAL.match(match.group("value") or ""):
                continue
            if index == 2 and _TS_MATCHER.search(line):
                continue
            found.append(_Setter(path, number, match.group("name"),
                                 "assignment"))
            break
    return found


def _setters_for(path, relative=None):
    """Every steering site in ONE file, by its language. Shared by the tree
    scan and the allow-list audit so the two can never disagree about what a
    setter is."""
    relative = relative or path.relative_to(REPO_ROOT).as_posix()
    source = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix in _PY_SUFFIXES:
        return python_setters(source, relative, filename=str(path))
    return typescript_setters(source, relative)


def _scan_tree():
    """Every steering site under `tests/`, allow-listed entries removed.

    `__pycache__` is skipped: a stale `.pyc` is a build artefact, and its
    bytecode still carries the string constants of a source that has already
    been corrected.
    """
    offenders = []
    scanned = 0
    for path in sorted(TESTS_DIR.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        suffix = path.suffix
        if suffix not in _PY_SUFFIXES + _TS_SUFFIXES:
            continue
        relative = path.relative_to(REPO_ROOT).as_posix()
        if relative in DEADNESS_PROOFS:
            continue
        scanned += 1
        offenders += _setters_for(path, relative)
    return scanned, offenders


_POSITIVE_CONTROL_PY = '''
import os
PORT_VAR = "CRUCIBLE_PORT"


def steer(port, board):
    os.environ["CRUCIBLE_URL"] = board
    env = {"CRUCIBLE_BASE": board}
    env[PORT_VAR] = str(port)
    os.environ.setdefault("CRUCIBLE_HOST", "127.0.0.1")
    return _patched_env(CRUCIBLE_PORT=str(port), env=env)
'''

_NEGATIVE_CONTROL_PY = '''
import os

#: CRUCIBLE_PORT and CRUCIBLE_URL are retired -- prose, not a channel.
ENV_KEYS = ("CRUCIBLE_URL", "CRUCIBLE_BASE", "CRUCIBLE_PORT", "CRUCIBLE_HOST")
PORT_VAR = "CRUCIBLE_PORT"


def hygiene(env):
    """A docstring naming CRUCIBLE_HOST is prose too."""
    for key in ENV_KEYS:
        os.environ.pop(key, None)
    env["CRUCIBLE_DB"] = "/tmp/crucible.db"
    assert PORT_VAR not in env
    return {"CRUCIBLE_URL": None, PORT_VAR: None}
'''

_POSITIVE_CONTROL_TS = '''
const proc = spawn("bun", ["run", "src/server.ts"], {
  env: { ...process.env, CRUCIBLE_PORT: String(port) },
});
process.env.CRUCIBLE_URL = board;
await $`CRUCIBLE_BASE=${board} bun run x.ts`;
'''

_NEGATIVE_CONTROL_TS = '''
// `$CRUCIBLE_PORT` is retired, so the child listens per its own file.
/* CRUCIBLE_URL = nothing reads it */
 * CRUCIBLE_HOST is named here only in prose
delete process.env.CRUCIBLE_BASE;
const env = { CRUCIBLE_DB: dbPath, CRUCIBLE_PORT: undefined };
'''


class TheDetectorSeesSteeringAndIgnoresProseTest(unittest.TestCase):
    """The controls. A guard whose verdict is green because its detector is
    blind is worse than no guard: it reports coverage the project does not
    have. Both halves are asserted before any real file is scanned.
    """

    def test_the_python_detector_finds_every_shape_a_fixture_can_steer_with(self):
        found = python_setters(_POSITIVE_CONTROL_PY, "<positive>")
        self.assertEqual(
            [(s.name, s.shape) for s in found],
            [("CRUCIBLE_URL", "subscript store"),
             ("CRUCIBLE_BASE", "dict entry"),
             ("CRUCIBLE_PORT", "subscript store"),
             ("CRUCIBLE_HOST", "setdefault"),
             ("CRUCIBLE_PORT", "keyword argument")],
            "the detector must see all five steering shapes, in source order, "
            f"including the one spelled through a constant; saw {found!r}")

    def test_the_python_detector_passes_removals_prose_and_names_used_as_data(self):
        found = python_setters(_NEGATIVE_CONTROL_PY, "<negative>")
        self.assertEqual(
            found, [],
            "a pop, an ENV_KEYS tuple, a None value, a docstring and a name "
            f"compared rather than assigned are not steering; flagged {found!r}")

    def test_the_typescript_detector_finds_env_objects_assignments_and_shell_words(self):
        found = typescript_setters(_POSITIVE_CONTROL_TS, "<positive>")
        self.assertEqual(
            [s.name for s in found],
            ["CRUCIBLE_PORT", "CRUCIBLE_URL", "CRUCIBLE_BASE"],
            f"the three TypeScript steering shapes must all be seen; "
            f"saw {found!r}")

    def test_the_typescript_detector_passes_comments_deletes_and_undefined(self):
        found = typescript_setters(_NEGATIVE_CONTROL_TS, "<negative>")
        self.assertEqual(
            found, [],
            "a comment, a `delete`, an `undefined` value and a CRUCIBLE_DB "
            f"entry are not steering; flagged {found!r}")

    def test_the_guard_reads_a_real_and_substantial_part_of_the_suite(self):
        """The scan itself is asserted to have work to do. A `rglob` that
        matched nothing -- a moved directory, a renamed suffix -- would make
        every claim below vacuously true."""
        scanned, _ = _scan_tree()
        self.assertGreater(
            scanned, 150,
            f"the guard must scan the whole suite tree under {TESTS_DIR}; "
            f"only {scanned} source files were read")


class NoTestSteersAClientOrAServerByARetiredVariableTest(unittest.TestCase):
    """§S1b -- the four retired variables are not a channel any suite uses.
    """

    def test_no_source_file_under_tests_sets_a_retired_variable(self):
        """RED today: the census's `drive_verb`, the gate suites and several
        bun server-spawners still aim a retired variable. Each is named with
        its own `file:line` because the fix is per-site: declare the board in
        the fixture's project file, or the listener in its store dir."""
        _, offenders = _scan_tree()
        report = "\n".join(f"  {s.path}:{s.line} sets ${s.name} ({s.shape})"
                           for s in offenders)
        self.assertEqual(
            offenders, [],
            f"{len(offenders)} site(s) under tests/ still steer a client or a "
            f"server through a RETIRED variable. Nothing reads these, so each "
            f"drive silently lands on the shipped default -- port 3849 / "
            f"http://localhost:3849, the production board on a two-instance "
            f"machine. Declare `[client] url` in the fixture's project root, "
            f"or `[server] port` in its store dir, instead:\n{report}")

    def test_the_two_surviving_variables_are_not_touched_by_this_guard(self):
        """§S3 -- `CRUCIBLE_DB` and `CRUCIBLE_PROJECT_KEY` PRECEDE configuration
        discovery and stay environment-resolved. A guard that had quietly
        widened to every `CRUCIBLE_*` name would break every fixture that
        points a server at its own temp database, so the boundary is asserted
        rather than left to the regex."""
        for name in ENVIRONMENT_RESOLVED_STILL:
            with self.subTest(variable=name):
                self.assertNotIn(name, RETIRED_VARIABLES)
                found = python_setters(
                    f'import os\nos.environ["{name}"] = "x"\n', "<stay>")
                self.assertEqual(
                    found, [],
                    f"${name} stays environment-resolved (§S3) and setting it "
                    f"must never be reported as steering")

    def test_every_allow_listed_deadness_proof_exists_and_states_its_reason(self):
        """The exemption cannot rot. A path that has been renamed or deleted
        would leave a silent hole in the guard the next time a setter landed in
        a file with that name, and an entry with no reason is an exemption
        nobody can review."""
        self.assertLessEqual(
            len(DEADNESS_PROOFS), 5,
            "the exemption is for suites whose SUBJECT is that a retired "
            "variable is dead; a growing list means it has become a place to "
            f"park migrations: {sorted(DEADNESS_PROOFS)!r}")
        for relative, reason in sorted(DEADNESS_PROOFS.items()):
            with self.subTest(path=relative):
                self.assertTrue(
                    (REPO_ROOT / relative).is_file(),
                    f"allow-listed path {relative} does not exist -- a stale "
                    f"exemption silently un-guards whatever takes its name")
                self.assertGreater(
                    len(reason), 40,
                    f"{relative} is exempt without a stated reason")

    def test_each_allow_listed_file_really_proves_the_variable_is_dead(self):
        """An exemption is only legitimate while the file is still ASSERTING
        the retirement. Each allow-listed suite must both aim a retired
        variable and assert the outcome did not follow it -- otherwise it is an
        ordinary steering site wearing an exemption."""
        for relative in sorted(DEADNESS_PROOFS):
            with self.subTest(path=relative):
                path = REPO_ROOT / relative
                source = path.read_text(encoding="utf-8")
                setters = _setters_for(path, relative)
                self.assertNotEqual(
                    setters, [],
                    f"{relative} is exempt as a DEADNESS PROOF but sets no "
                    f"retired variable at all -- remove the exemption")
                self.assertIn(
                    "retired", source.lower(),
                    f"{relative} must say, in its own text, that the variable "
                    f"it exports is retired -- that claim is the exemption")
