"""CR-CRU-107 §S1 (cycle 367 RED) -- the HELP and the `next` START TEMPLATE
teach one label per flag.

Acceptance criteria pinned VERBATIM from
docs/changes/CR-CRU-107-a-cycle-label-list-refuses-the-wrong-delimiter.md:

  AC7 -- "`plan-file --help` on each of the five clients shows `--cycle` as
  repeatable and names it before `--cycles`, and `--cycles`' own help says it
  is the legacy comma-split form. The five help strings are byte-identical to
  each other, as they are today."

  AC8 -- "`_next_start_help`'s emitted template uses `--cycle`, so the `next`
  verb's `help[]` hands back a call that cannot be mis-delimited. Asserted on
  the shared function and on the `next` envelope of at least one client."

And the requirement behind them, §S1: "`--cycle` is the canonical form. It is
what `plan-file --help` shows first, and what the `next` verb's start template
emits (`_next_start_help`, which today prints `--cycles \"<c1,c2>\"`)."

WHAT IS DRIVEN, and why no assertion here reads client SOURCE:
  * AC7 -- each client's REAL `plan-file --help` is invoked (`main()` with
    `sys.argv` patched, the sibling idiom of
    `test_cr097_cr_help_namespace_neutral.py`) and its ACTUAL rendered stdout
    is parsed into option entries. Source order is what a reader NEVER sees;
    the rendered options block is.
  * AC8 -- the shared `_next_start_help` is called directly, AND one client's
    `next` verb is driven for real with its `_get` board read MOCKED, so the
    template is asserted where an orchestrator actually copies it from: the
    `help[]` of a decoded TOON envelope. The live board on :3849 is never
    touched.

ORDERING, one form only (the dispatch asked for a ruling): "appears before"
is asserted on the RENDERED `--help` ORDERING, not on declaration order.
Declaration order is a source fact that only matters because argparse happens
to render in it today; the criterion is about what a reader hits first, and a
formatter change (sorted options, a custom formatter, an argument group) would
leave declaration order green while the reader still meets the legacy flag
first. Rendered order is also strictly stronger: it can only hold if the
declaration order that feeds it holds. Asserting both would pin the same fact
twice and pin argparse's internals as a bonus.

BYTE-IDENTICAL, made precise: the five parsers align their help COLUMN to
their own longest flag (`--project-dir PROJECT_DIR` on one client,
`--maven-dir MAVEN_DIR` on another), so the rendered blocks differ in run
lengths of spaces for reasons that have nothing to do with the copy. What AC7
calls byte-identical is the COPY, so each entry's body is compared with its
internal whitespace runs collapsed -- wrapping is a rendering artefact of the
terminal width, the words are the contract.

BUN'S MODULE-DOCSTRING VERB TABLE (`clients/bun-crucible.py:34`, which reads
`--cycles "a,b[,c...]"`) is deliberately NOT asserted here. MEASURED at
`a7fe101`: `bun-crucible.py --help` renders `_CLI_DESCRIPTION`, never
`__doc__` -- CR-CRU-097 §S2 severed that wiring on purpose ("deliberately NOT
`__doc__`", `clients/bun-crucible.py:1925-1943`), and a drive of the root help
finds zero occurrences of the table's `a,b[,c...]` string. It is a design
record, not user-visible output, so a test asserting on it would pin prose. It
is left to GREEN as a comment-only correction.

RED phase, against `a7fe101`:
  * every client renders `--cycles` BEFORE `--cycle` (measured: the options
    block lists `--cycles CYCLES` then `--cycle CYCLE` on all five), so the
    ordering test fails five for five;
  * no client's `--cycles` help says legacy -- all five render
    `Comma-separated cycle labels, e.g. "a,b,c".` -- so the legacy test fails
    five for five;
  * `_next_start_help` emits `--cycles "<c1,c2>"`
    (`clients/_crucible_axi.py:1481-1490`), so both AC8 shared-function tests
    and the driven-envelope test fail.
The two tests that PASS ON ARRIVAL are stated as such in their docstrings:
cycle 366 already shipped a repeatable-flag help string, byte-identical across
the five. They are kept because GREEN edits exactly those strings.

Invocation:
    python3 -m pytest tests/client/test_plan_file_cycle_flag_help.py -q
Fallback:
    python3 tests/client/test_plan_file_cycle_flag_help.py
"""

import contextlib
import importlib.util
import io
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"

CLIENT_FILES = {
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
}

AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
TOON_PATH = CLIENTS_DIR / "toon.py"

PLAN_FILE_VERB = "plan-file"
REPEATABLE_FLAG = "--cycle"
LEGACY_FLAG = "--cycles"

# The fixture CR the `next` fixtures name. A namespace that belongs to no
# project, held in a constant so no assertion below spells a CR id at all.
FIXTURE_CR = "CR-AAA-7"
FIXTURE_WAVE = "5"

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
# `--cycle` NOT followed by another word character: `--cycles` must not match.
_REPEATABLE_OCCURRENCE = re.compile(r"--cycle(?![-\w])")
# The repeatable flag carrying its OWN quoted placeholder label.
_REPEATABLE_WITH_LABEL = re.compile(r'--cycle(?![-\w])\s+"<[^"]+>"')


def _load_module(path, name):
    if not path.exists():
        raise unittest.SkipTest(f"{path} not found")
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv, prog):
    """`module.main()` with `sys.argv` patched. Only SystemExit is caught --
    `--help` exits 0 through it -- so any other exception surfaces as an
    ERROR rather than being scored as a help string."""
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", [prog] + argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                if e.code is None:
                    code = 0
                elif isinstance(e.code, int):
                    code = e.code
                else:
                    code = 1
    return code, stdout.getvalue(), stderr.getvalue()


def _plan_file_help(name):
    """The client's REAL `plan-file --help` stdout, at a FIXED terminal width
    so the wrap points are a property of the copy rather than of whatever
    terminal the suite happens to run under."""
    module = _load_module(CLIENT_FILES[name], f"cycle_flag_help_{name}_under_test")
    with mock.patch.dict(os.environ, {"COLUMNS": "100"}):
        code, out, err = _run_main(
            module, [PLAN_FILE_VERB, "--help"], str(CLIENT_FILES[name]))
    return code, _ANSI.sub("", out + err)


def _option_entries(help_text):
    """The rendered options block, in RENDER ORDER: a list of
    `(flags, body)` -- the flag spellings an entry declares, and its help copy
    with whitespace runs collapsed.

    An entry opens on a line indented exactly two spaces whose first character
    is `-` (argparse's option column); its continuation lines are indented to
    the help column. So `repeat --cycle per cycle` INSIDE a body never opens a
    phantom entry, which is the whole reason this is parsed rather than
    grepped."""
    entries = []
    for line in help_text.splitlines():
        opener = re.match(r"^ {2}(-\S.*)$", line)
        if opener is not None:
            spec = opener.group(1)
            parts = re.split(r"\s{2,}", spec, maxsplit=1)
            flags = tuple(token.rstrip(",") for token in parts[0].split()
                          if token.startswith("-"))
            body = parts[1] if len(parts) > 1 else ""
            entries.append([flags, [body] if body else []])
        elif entries and line.startswith("    ") and line.strip():
            entries[-1][1].append(line.strip())
    return [(flags, " ".join(" ".join(body).split()))
            for flags, body in entries]


def _entry_index(entries, flag):
    for index, (flags, _body) in enumerate(entries):
        if flag in flags:
            return index
    return None


def _entry_body(entries, flag):
    for flags, body in entries:
        if flag in flags:
            return body
    return None


class _PlanFileHelpTest(unittest.TestCase):
    """AC7 -- the copy every reader of every client meets."""

    @classmethod
    def setUpClass(cls):
        cls.rendered = {}
        for name in sorted(CLIENT_FILES):
            code, text = _plan_file_help(name)
            cls.rendered[name] = (code, text, _option_entries(text))

    def _entries(self, name):
        """NON-VACUITY, per client: the help really rendered and really
        documents BOTH flags. Without this every rule below would pass on an
        empty string -- a mis-spelled verb, an argparse error, a client that
        failed to load."""
        code, text, entries = self.rendered[name]
        self.assertEqual(
            0, code,
            f"{name}: `{PLAN_FILE_VERB} --help` must exit 0; got {code} :: "
            f"{text[:400]!r}")
        for flag in (REPEATABLE_FLAG, LEGACY_FLAG):
            self.assertIsNotNone(
                _entry_index(entries, flag),
                f"{name}: `{PLAN_FILE_VERB} --help` must render an options "
                f"entry for {flag}, else every rule about it is vacuous :: "
                f"{text[:600]!r}")
        return entries


class PlanFileHelpTeachesTheCanonicalFlagTest(_PlanFileHelpTest):

    def test_every_client_documents_the_repeatable_flag_as_one_label_never_split(self):
        """AC7, first half. PASSES ON ARRIVAL -- cycle 366 shipped this copy
        (`One cycle label, never split; repeat --cycle per cycle.`). Kept
        because GREEN rewrites exactly these strings to reorder them, and a
        reorder that drops `repeat` would ship a flag nobody knows to repeat."""
        offenders = {}
        for name in sorted(CLIENT_FILES):
            body = _entry_body(self._entries(name), REPEATABLE_FLAG).lower()
            missing = [word for word in ("repeat", "never split")
                       if word not in body]
            if missing:
                offenders[name] = f"missing {missing} :: {body!r}"
        self.assertEqual(
            offenders, {},
            f"every client's `{PLAN_FILE_VERB} --help` must teach "
            f"{REPEATABLE_FLAG} as REPEATABLE and never split (AC7); "
            f"offenders: {offenders}")

    def test_every_client_renders_the_repeatable_flag_before_the_legacy_one(self):
        """AC7 -- "names it before `--cycles`". Asserted on the RENDERED
        options block (see the module docstring's ruling), so what is pinned
        is the order a reader meets, not the order argparse was called in."""
        offenders = {}
        for name in sorted(CLIENT_FILES):
            entries = self._entries(name)
            canonical = _entry_index(entries, REPEATABLE_FLAG)
            legacy = _entry_index(entries, LEGACY_FLAG)
            if canonical > legacy:
                offenders[name] = (
                    f"{REPEATABLE_FLAG} rendered at option #{canonical}, "
                    f"{LEGACY_FLAG} at #{legacy}")
        self.assertEqual(
            offenders, {},
            f"{REPEATABLE_FLAG} is the canonical form (§S1), so every "
            f"client's `{PLAN_FILE_VERB} --help` must show it BEFORE "
            f"{LEGACY_FLAG}; offenders: {offenders}")

    def test_every_client_marks_the_comma_split_flag_as_the_legacy_form(self):
        """AC7 -- "`--cycles`' own help says it is the legacy comma-split
        form". A reader who meets two cycle flags must be able to tell from
        the help alone which one this CR wants used; "comma-separated" alone
        describes it without ranking it."""
        offenders = {}
        for name in sorted(CLIENT_FILES):
            body = _entry_body(self._entries(name), LEGACY_FLAG).lower()
            missing = [word for word in ("legacy", "comma") if word not in body]
            if missing:
                offenders[name] = f"missing {missing} :: {body!r}"
        self.assertEqual(
            offenders, {},
            f"every client's {LEGACY_FLAG} help must name itself the LEGACY "
            f"comma-split form (AC7); offenders: {offenders}")

    def test_the_fleet_renders_one_help_copy_per_cycle_flag(self):
        """AC7 -- "The five help strings are byte-identical to each other, as
        they are today." PASSES ON ARRIVAL, and that is precisely the state
        being defended: a fleet whose help drifts per client is the CR-054
        defect class, and this CR edits both strings on all five files at
        once, which is exactly when drift gets introduced."""
        for flag in (REPEATABLE_FLAG, LEGACY_FLAG):
            with self.subTest(flag=flag):
                bodies = {name: _entry_body(self._entries(name), flag)
                          for name in sorted(CLIENT_FILES)}
                distinct = sorted(set(bodies.values()))
                self.assertEqual(
                    len(distinct), 1,
                    f"all five clients must render ONE help copy for {flag}; "
                    f"got {len(distinct)} distinct: {bodies}")


class NextStartTemplateTeachesTheCanonicalFlagTest(unittest.TestCase):
    """AC8 -- the call an orchestrator copies verbatim."""

    @classmethod
    def setUpClass(cls):
        cls.axi = _load_module(AXI_MODULE_PATH, "crucible_axi_under_test_for_cycle_help")

    def _template(self):
        steps = self.axi._next_start_help({"cr": FIXTURE_CR, "wave": FIXTURE_WAVE})
        self.assertTrue(
            steps, "the start template must be a non-empty help[] -- an empty "
                   "one would make every rule below vacuous")
        step = steps[0]
        # Non-vacuity: this really is the plan-file start call, still carrying
        # the entry's own cr and wave (CR-CRU-092 AC2, untouched here).
        self.assertIn(f"{PLAN_FILE_VERB} --cr {FIXTURE_CR}", step)
        self.assertIn(f"--wave {FIXTURE_WAVE}", step)
        return step

    def test_the_start_template_hands_back_the_repeatable_flag_and_no_comma_split_one(self):
        """§S1/AC8 -- the template emits `--cycle`. A template still spelling
        `--cycles "<c1,c2>"` reintroduces the delimiter defect on the next
        filing no matter how good the help is, because the template is what
        gets pasted."""
        step = self._template()
        self.assertNotIn(
            f'{LEGACY_FLAG} ', step,
            f"the `next` start template must no longer hand back the "
            f"comma-split form (AC8); got {step!r}")
        self.assertRegex(
            step, _REPEATABLE_OCCURRENCE,
            f"the `next` start template must hand back {REPEATABLE_FLAG} "
            f"(AC8); got {step!r}")

    def test_the_start_template_shows_the_flag_repeated_with_its_own_label(self):
        """§S1 -- "one occurrence per cycle, in order". A template showing a
        single `--cycle "<label>"` teaches a one-cycle plan and quietly loses
        the point of the flag; the reader must see the repetition. Bounded
        above so a runaway template (a whole synthetic plan pasted into the
        help) fails here rather than reading as success."""
        step = self._template()
        labelled = _REPEATABLE_WITH_LABEL.findall(step)
        occurrences = _REPEATABLE_OCCURRENCE.findall(step)
        self.assertGreaterEqual(
            len(labelled), 2,
            f"the template must REPEAT {REPEATABLE_FLAG}, each occurrence "
            f"carrying its own quoted placeholder label; found "
            f"{len(labelled)} in {step!r}")
        self.assertLessEqual(
            len(occurrences), 3,
            f"two or three occurrences teach the repetition; more is a "
            f"template pasting a plan; found {len(occurrences)} in {step!r}")


class NextEnvelopeCarriesTheCanonicalFlagTest(unittest.TestCase):
    """AC8 -- "asserted ... on the `next` envelope of at least one client".
    The shared function is not the wire: what an orchestrator reads is the
    decoded `help[]` of a real client's `next` envelope, reached through that
    client's own dispatch, ops seam and emitter."""

    CLIENT = "bun"
    PROJECT_KEY = "test-key-cycle-flag-help"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                "WORKFLOW_CYCLE", "WORKFLOW_TRACK")

    def setUp(self):
        self.module = _load_module(
            CLIENT_FILES[self.CLIENT], "cycle_flag_next_client_under_test")
        self.toon = _load_module(TOON_PATH, "toon_under_test_for_cycle_flag_help")
        self.tmpdir = tempfile.mkdtemp(prefix="cycle-flag-help-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _queue(self):
        return {"ok": True, "entries": [
            {"cr": FIXTURE_CR, "wave": FIXTURE_WAVE, "dependsOn": [],
             "status": "PENDING", "seq": 10},
        ]}

    def test_the_next_envelope_help_hands_back_the_repeatable_flag(self):
        """AC8 on the wire. The board GET is MOCKED -- the running board on
        :3849 is never read -- and the POST seam is mocked shut so a `next`
        that ever wrote would be visible rather than silently tolerated."""
        with mock.patch.object(self.module, "_get", return_value=self._queue(),
                               create=True), \
             mock.patch.object(self.module, "_post", return_value={"ok": True},
                               create=True) as post_mock:
            code, out, err = _run_main(
                self.module, ["next", "--project-dir", self.tmpdir],
                str(CLIENT_FILES[self.CLIENT]))

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        post_mock.assert_not_called()
        axi = self.toon.decode(out)["axi"]
        self.assertEqual(axi.get("verb"), "next")
        self.assertEqual(axi.get("decision"), "NEXT",
                         f"the fixture lane must resolve to NEXT, else the "
                         f"start template is never emitted; got {axi!r}")
        steps = axi.get("help") or []
        start = [s for s in steps if s.startswith(f"{PLAN_FILE_VERB} ")]
        self.assertTrue(
            start,
            f"the `next` envelope must carry the plan-file start call in "
            f"help[]; got {steps!r}")
        self.assertNotIn(
            f"{LEGACY_FLAG} ", start[0],
            f"the `next` envelope's start call must not hand an orchestrator "
            f"the comma-split form (AC8); got {start[0]!r}")
        self.assertGreaterEqual(
            len(_REPEATABLE_WITH_LABEL.findall(start[0])), 2,
            f"the `next` envelope's start call must hand back a REPEATED "
            f"{REPEATABLE_FLAG} (AC8); got {start[0]!r}")


if __name__ == "__main__":
    unittest.main()
