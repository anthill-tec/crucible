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

A fixture that READS one and supplies its own fallback is the same fixture
with the accident already committed: `process.env.CRUCIBLE_URL ??
"http://localhost:3849"` names the production board in source, and since
nothing sets that variable any more it is the literal, every time. Either
production answers and the suite asserts against the wrong board, or nothing
answers and the suite passes VACUOUSLY, having quietly lost the live-board
coverage it claims. So STEERING here is the whole channel -- the aim and the
obedience -- not the assignment half of it.

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
it is asserted to exist, so it cannot rot into a blanket exemption. It also
subtracts SHAPES rather than files: an allow-listed suite that READ a retired
name would still be reported, because nothing about proving an export lands
nowhere requires the same file to obey one.

── Why a detector rather than a grep ────────────────────────────────

Measured 2026-09-17 at HEAD, `tests/` mentions the four names 456 times, and
the large majority are the three exempt classes above. A text guard would
either flag those (forbidding C1's own deadness proofs) or be loosened until it
flagged nothing. So the python half is an AST pass over the real syntax of an
assignment -- subscript store, dict entry, keyword argument, `setdefault` --
with ONE level of name indirection resolved, because `env[SERVER_PORT_ENV_VAR]
= port` is the same steering spelled through a constant. The TypeScript half is
a line scan over the shapes a bun suite can steer with -- three that ASSIGN
(`process.env.X =`, an `env: { X: ... }` entry, an `X=...` word in a shell
command string) and five that OBEY (`process.env.X ?? ...`, `... || ...`, a `!`
non-null assertion, and a subscript read off `process.env`/`Bun.env`) -- with
comment lines dropped. A `!==` comparison is excluded by lookahead: comparing
against a retired name is what a deadness proof does.

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
#:
#: The exemption is over SHAPES, not over files -- see `_OBEYING_SHAPES` below.
#: What these suites need exempting is the EXPORT they perform in order to
#: prove it lands nowhere; nothing in that claim needs them to be allowed to
#: OBEY a retired name as well.
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

#: The three shapes a TypeScript suite can steer ASSIGNING with. `undefined`
#: on the right-hand side is a REMOVAL, filtered below beside python's `None`.
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

#: The shapes a TypeScript suite can steer READING with.
#:
#: An assignment is only half of the channel, and it is the half the criterion
#: does NOT turn on: its words are "no file under `tests/` STEERS a client or a
#: server by any of the four retired variables", and a suite that does
#: `const base = process.env.CRUCIBLE_URL ?? "http://localhost:3849"` and then
#: `fetch(base)` is steering by one of them just as surely as a suite that
#: exports it. Worse, in fact: the export at least lands where the fixture
#: aimed, while a READ of a name nothing sets any more lands on the FALLBACK --
#: the shipped default, which on a two-instance workstation is the PRODUCTION
#: board. Either production answers and the suite asserts against the wrong
#: board, or nothing answers and the suite passes VACUOUSLY.
#:
#: So the trigger is a retired name being read WITH a fallback or an assertion
#: attached -- `?? …`, `|| …`, a `!` non-null assertion, or a subscript read off
#: `process.env`/`Bun.env`. Each of those says, in source, "this value may be
#: absent and I have decided what to do about it", which is the decision a
#: retired variable no longer gets to participate in. `!==`/`!=` are
#: comparisons rather than the non-null assertion, and are excluded by the
#: lookahead, because comparing against a retired name is the shape a DEADNESS
#: PROOF uses.
_TS_READS = (
    ("read with a `??` fallback",
     re.compile(r"process\.env\.(?P<name>" + "|".join(RETIRED_VARIABLES)
                + r")\s*\?\?")),
    ("read with a `||` fallback",
     re.compile(r"process\.env\.(?P<name>" + "|".join(RETIRED_VARIABLES)
                + r")\s*\|\|")),
    ("read with a non-null assertion",
     re.compile(r"process\.env\.(?P<name>" + "|".join(RETIRED_VARIABLES)
                + r")\s*!(?!=)")),
    ("subscript read",
     re.compile(r"(?:process|Bun)\.env\[\s*[\"'](?P<name>"
                + "|".join(RETIRED_VARIABLES) + r")[\"']\s*\]")),
    ("Bun.env read",
     re.compile(r"Bun\.env\.(?P<name>" + "|".join(RETIRED_VARIABLES)
                + r")\b")),
)

#: The shapes `DEADNESS_PROOFS` does NOT excuse: the OBEYING half, derived
#: from `_TS_READS` so a read shape added later is enforced by construction.
#:
#: A deadness proof's subject is an EXPORT that lands nowhere, so its exports
#: are exempt. Its reads are not. Nothing about proving an export is dead
#: requires the same file to resolve a board THROUGH one of these names, and
#: `process.env.CRUCIBLE_URL ?? "http://localhost:3849"` written inside an
#: allow-listed file lands on the production board exactly as it would
#: anywhere else. Exempting the FILE would hide that, and the rot-guards below
#: would not catch it: they ask only that the file still carries a setter and
#: still says "retired", both of which would still be true. A guard whose
#: scope is narrower than the criterion it certifies certifies rather than
#: protects, so the allow-list subtracts SHAPES and never a file.
_OBEYING_SHAPES = frozenset(shape for shape, _ in _TS_READS)


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
        return f"{self.path}:{self.line} steers by {self.name} ({self.shape})"


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
    """Every retired-variable STEERING SITE in a `.ts` source, by line scan --
    an assignment that aims one, or a read that has decided what to do when one
    is absent.

    Comment lines are dropped first: the bun suites discuss the retired
    variables at length (C1 left the reasoning in place beside the code it
    changed), and prose is not a channel.

    Reads are scanned AFTER assignments so a line that is both keeps its more
    specific description, and at most one site is reported per line either way:
    the reader has one line to go and change.
    """
    found = []
    for number, line in enumerate(source.splitlines(), start=1):
        if _TS_COMMENT.match(line):
            continue
        site = None
        for index, pattern in enumerate(_TS_SETTERS):
            match = pattern.search(line)
            if match is None:
                continue
            if _TS_REMOVAL.match(match.group("value") or ""):
                continue
            if index == 2 and _TS_MATCHER.search(line):
                continue
            site = _Setter(path, number, match.group("name"), "assignment")
            break
        if site is None:
            for shape, pattern in _TS_READS:
                match = pattern.search(line)
                if match is not None:
                    site = _Setter(path, number, match.group("name"), shape)
                    break
        if site is not None:
            found.append(site)
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


def enforced_sites(relative, sites):
    """The sites in ONE file that the criterion still holds against, after the
    allow-list has been applied.

    For a file nobody exempted, that is all of them. For a DEADNESS PROOF it is
    the OBEYING half only: the export is the suite's subject and is excused,
    the read is not excused anywhere, by anyone. Every allow-listed file is
    still opened and still scanned -- the exemption subtracts shapes from the
    verdict, it does not stop the guard from looking.
    """
    if relative not in DEADNESS_PROOFS:
        return list(sites)
    return [site for site in sites if site.shape in _OBEYING_SHAPES]


def _scan_tree():
    """Every steering site under `tests/`, allow-listed SHAPES removed.

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
        scanned += 1
        offenders += enforced_sites(relative, _setters_for(path, relative))
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

#: The READ half. Every line here is a drive aimed by a retired name: the value
#: is absent, so each one silently lands on the literal beside it.
_POSITIVE_CONTROL_TS_READS = '''
const base = process.env.CRUCIBLE_URL ?? "http://localhost:3849";
const fallback = process.env.CRUCIBLE_BASE || "http://localhost:3849";
const asserted = process.env.CRUCIBLE_PORT!;
const viaSubscript = process.env["CRUCIBLE_HOST"];
const viaBun = Bun.env["CRUCIBLE_URL"];
const viaBunDot = Bun.env.CRUCIBLE_BASE ?? board;
await fetch(`${base}/api/v2/projects/${key}/runs`);
'''

#: A read that decides NOTHING, a COMPARISON against a retired name (the shape
#: every deadness proof uses -- `!==` is not the `!` non-null assertion), and
#: the two variables §S3 keeps.
_NEGATIVE_CONTROL_TS_READS = '''
expect(process.env.CRUCIBLE_PORT).toBeUndefined();
if (process.env.CRUCIBLE_URL !== undefined) throw new Error("retired");
const store = process.env.CRUCIBLE_DB ?? defaultStore;
const key = process.env["CRUCIBLE_PROJECT_KEY"]!;
// process.env.CRUCIBLE_BASE ?? board -- prose about a line that was deleted
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

    def test_the_typescript_detector_finds_a_read_that_falls_back_to_the_default(self):
        """The half that was missing, and the half the criterion's own words
        cover. A suite that READS a retired name and supplies its own fallback
        is steering by that name: nothing sets it any more, so the fallback is
        what every request goes to -- `http://localhost:3849`, the production
        board on the two-instance workstation this CR serves.
        """
        found = typescript_setters(_POSITIVE_CONTROL_TS_READS, "<positive>")
        self.assertEqual(
            [(s.name, s.shape) for s in found],
            [("CRUCIBLE_URL", "read with a `??` fallback"),
             ("CRUCIBLE_BASE", "read with a `||` fallback"),
             ("CRUCIBLE_PORT", "read with a non-null assertion"),
             ("CRUCIBLE_HOST", "subscript read"),
             ("CRUCIBLE_URL", "subscript read"),
             ("CRUCIBLE_BASE", "Bun.env read")],
            "a read with a fallback or an assertion attached is a steering "
            "site: the criterion says no file under tests/ steers a client or "
            "a server BY one of these names, and a detector that sees only "
            f"the setter half certifies what it cannot see; saw {found!r}")

    def test_the_typescript_detector_passes_comparisons_and_the_surviving_pair(self):
        """The boundary the read half must not cross. `!==` against a retired
        name is a DEADNESS PROOF asserting the variable is gone, not a channel;
        and `$CRUCIBLE_DB`/`$CRUCIBLE_PROJECT_KEY` (§S3) are still read with a
        fallback everywhere, legitimately."""
        found = typescript_setters(_NEGATIVE_CONTROL_TS_READS, "<negative>")
        self.assertEqual(
            found, [],
            "an `expect(...)`, a `!==` comparison, a §S3 survivor and a "
            f"comment are not steering reads; flagged {found!r}")

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
        report = "\n".join(f"  {s.path}:{s.line} steers by ${s.name} "
                           f"({s.shape})" for s in offenders)
        self.assertEqual(
            offenders, [],
            f"{len(offenders)} site(s) under tests/ still steer a client or a "
            f"server through a RETIRED variable. Nothing sets these any more, "
            f"so each drive silently lands on the shipped default -- port "
            f"3849 / http://localhost:3849, the production board on a "
            f"two-instance machine -- whether it was aimed by an export that "
            f"no longer arrives or by a read whose own fallback spells that "
            f"default out. Declare `[client] url` in the fixture's project "
            f"root, or `[server] port` in its store dir, and resolve it "
            f"through the product's own chain instead:\n{report}")

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

    def test_the_exemption_excuses_the_export_and_never_the_read(self):
        """The SCOPE of the allow-list, asserted on both sides.

        A deadness proof is exempt because its EXPORT is its subject. That is
        not a reason to make it the one place in the tree where a client may be
        pointed at the shipped default by a READ of a dead name, and the two
        rot-guards above cannot notice if it becomes one: they ask only that
        the file still sets a retired variable and still says "retired", and a
        file that had grown such a read would still do both. An exemption wider
        than its reason certifies what it does not check, so the obeying half
        stays enforced inside an allow-listed file, and the whole detector
        stays in force outside one.
        """
        relative = sorted(
            name for name in DEADNESS_PROOFS if name.endswith(".ts"))[0]
        source = ('process.env.CRUCIBLE_PORT = "9999";\n'
                  'const base = process.env.CRUCIBLE_URL ?? "http://localhost:3849";\n')
        sites = typescript_setters(source, relative)
        self.assertEqual(
            [s.line for s in sites], [1, 2],
            f"the detector must see both halves before the allow-list is "
            f"applied to them; saw {sites!r}")

        self.assertEqual(
            [(s.line, s.name, s.shape)
             for s in enforced_sites(relative, sites)],
            [(2, "CRUCIBLE_URL", "read with a `??` fallback")],
            f"inside {relative} the exemption must excuse the export it is "
            f"granted for and keep reporting a read that resolves a board "
            f"through a dead name -- that read lands on the shipped default "
            f"there exactly as it would in any other file")

        ordinary = "tests/an-ordinary-suite.test.ts"
        self.assertNotIn(ordinary, DEADNESS_PROOFS)
        self.assertEqual(
            [(s.line, s.shape)
             for s in enforced_sites(ordinary, typescript_setters(source,
                                                                 ordinary))],
            [(1, "assignment"), (2, "read with a `??` fallback")],
            "outside the allow-list nothing is subtracted at all")
