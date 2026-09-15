"""CR-CRU-131 §S1b -- what a CLIENT TELLS A USER about an abandoned run names
the LIMIT, not a retired environment variable.

`_run_left_open_warning` (clients/bun-crucible.py:979) builds the `{code,
detail}` entry that rides the AXI envelope when a run this client OPENED is
interrupted before it could be closed. Its detail currently ends:

    "... else `abandoned` once the run is older than CRUCIBLE_RUN_ABANDON_MS"

That is not a comment. It is text a user reads, on any project's board, and
after this cycle it names a lever that does not exist: setting
$CRUCIBLE_RUN_ABANDON_MS will not move the deadline by one millisecond. Advice
that cannot be followed is worse than none -- a user pulls the lever, nothing
changes, and nothing says why.

So the detail must name the LIMIT the server actually resolves --
`run_abandon_ms`, in the server's own `crucible.toml` -- and no retired
variable. The client does not resolve that limit and must not pretend to: the
server enforces it, possibly on another machine (CR-CRU-131 Context, the
ownership split). Naming it is all a client can honestly do, and all it needs
to do.

-- Why this file drives the BUILDER and not another signalled run -----------

tests/client/test_cr017_client_lifecycle.py already drives the real SIGINT and
SIGTERM paths end to end against a fake board, and asserts that the envelope's
warning text says the run was left to the server's own `auto-abort` and was
`abandoned` rather than lost. That is the wiring proof, and it exists. What it
does NOT pin is WHICH lever the text sends the reader to, which is exactly what
this cycle changes. This file pins that, on the one production function whose
return value IS that text -- so a second process spawn buys nothing a direct
call does not already give, and the two files together cover the path and its
wording without either repeating the other.

-- Where the SOURCE scan lives ---------------------------------------------

There is exactly ONE scan for a retired name across the shipped tree, and it is
on the bun side (tests/limits-have-no-environment-layer.test.ts), walking
`src/`, `clients/` and `public/` together -- one walker, both stacks, the "no
seventh walker" discipline CR-CRU-128 §S2 established. It is what catches the
module comment at clients/bun-crucible.py:943. This file asserts BEHAVIOUR: what
a user is told.

Invocation:
    python3 -m pytest tests/client/test_open_run_warning_names_the_limit.py -q
"""

import importlib.util
import itertools
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BUN_CLIENT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"
RETIRED_ENV_DECLARATION = REPO_ROOT / "tests" / "helpers" / "server-limits-fixture.ts"

#: The environment variables CR-CRU-131 RETIRES as limit overrides.
#:
#: DECLARED ONCE, on the bun side, in `RETIRED_LIMIT_ENV`
#: (tests/helpers/server-limits-fixture.ts) -- the copy here is checked against
#: that declaration by `TheRetiredSetIsOneListTest` below, so a fourth
#: retirement extends ONE array and this stack follows or fails. Two lists that
#: could quietly disagree is the `src/hints.ts` defect this CR family has
#: already hit twice.
RETIRED_LIMIT_ENV = (
    "CRUCIBLE_DEFAULT_RETENTION",
    "CRUCIBLE_RUN_ABANDON_MS",
    "CRUCIBLE_PROJECT_INACTIVE_MS",
)

#: The SERVER limit that actually decides when an open run is settled
#: `abandoned` -- its own name, as the operator's `crucible.toml` spells it
#: (src/limits.ts `SERVER_LIMIT_NAMES`), not a transliteration of the retired
#: variable.
RUN_ABANDON_LIMIT = "run_abandon_ms"

_COUNTER = itertools.count()


def _load_module_by_path(path, cache_key):
    """The fleet's own loader idiom, as every sibling test in this directory
    uses it (e.g. tests/client/test_client_limits_resolve_from_configuration.py).
    A FRESH module object per call, so no test inherits another's state."""
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OpenRunWarningTest(unittest.TestCase):
    """The warning a user actually receives when their run was interrupted."""

    RUN_ID = "run-019f6228-63a7-7000-b3d4-000000000131"
    CAUSE = "SIGINT received"

    def setUp(self):
        self.client = _load_module_by_path(
            BUN_CLIENT_PATH, "bun_crucible_open_run_warning_%d" % next(_COUNTER))
        builder = getattr(self.client, "_run_left_open_warning", None)
        if builder is None:
            raise AssertionError(
                "clients/bun-crucible.py exports no `_run_left_open_warning`. It is the "
                "function that builds the {code, detail} a user reads when a run this "
                "client opened could not be closed, and CR-CRU-131 §S1b changes what that "
                "detail must name.")
        self.warning = builder(self.RUN_ID, self.CAUSE)
        self.detail = self.warning.get("detail") or ""

    def test_the_detail_names_the_run_abandon_limit_a_user_can_actually_set(self):
        # Non-vacuity: the detail is real text about THIS run, not an empty
        # string that would satisfy every negative below for free.
        self.assertEqual(self.warning.get("code"), "run-left-open",
                         "the warning must still ride its own code; got %r"
                         % (self.warning,))
        self.assertIn(self.RUN_ID, self.detail,
                      "the detail must name the run that was left open; got %r"
                      % (self.detail,))
        self.assertIn(
            RUN_ABANDON_LIMIT, self.detail,
            "the detail must name the LIMIT that settles the run -- `%s`, which an "
            "operator sets in the server's crucible.toml -- since that is the only "
            "lever left once the environment override is retired; got %r"
            % (RUN_ABANDON_LIMIT, self.detail))

    def test_the_detail_names_no_retired_environment_variable(self):
        offenders = [name for name in RETIRED_LIMIT_ENV if name in self.detail]
        self.assertEqual(
            offenders, [],
            "the detail sends the user to %r, which this cycle retires: setting it "
            "moves no deadline, so the advice cannot be followed and the user has no "
            "way to learn that. Name the limit instead; got %r"
            % (offenders, self.detail))

    def test_the_detail_still_says_what_settles_the_run_and_that_it_is_not_lost(self):
        """CR-CRU-017 §S1's contract, which this cycle changes the WORDING of and
        must not change the MEANING of: the client posts no abort, the server
        settles the run on one of two triggers, and the run is abandoned rather
        than lost. tests/client/test_cr017_client_lifecycle.py asserts the first
        two reach a real signalled run's envelope; this keeps them true at the
        source when the sentence around them is rewritten."""
        for phrase in ("auto-abort", "agent died", "abandoned", self.CAUSE):
            self.assertIn(phrase, self.detail,
                          "the detail must still say %r; got %r" % (phrase, self.detail))


class TheRetiredSetIsOneListTest(unittest.TestCase):
    """The retirement's vocabulary is ONE declaration, read by both stacks."""

    def test_this_stacks_copy_matches_the_bun_declaration(self):
        text = RETIRED_ENV_DECLARATION.read_text(encoding="utf-8")
        match = re.search(
            r"RETIRED_LIMIT_ENV:\s*readonly\s+string\[\]\s*=\s*\[(.*?)\]", text, re.S)
        self.assertIsNotNone(
            match,
            "%s no longer declares RETIRED_LIMIT_ENV. It is the single list of retired "
            "limit variables; this stack reads it so a fourth retirement cannot land on "
            "one side only." % (RETIRED_ENV_DECLARATION,))
        declared = tuple(re.findall(r'"([^"]+)"', match.group(1)))
        # Non-vacuity: the parse found a real, non-empty vocabulary rather than
        # an empty list that would match any tuple by accident.
        self.assertEqual(len(declared), 3,
                         "expected the three retired variables; parsed %r" % (declared,))
        self.assertEqual(declared, RETIRED_LIMIT_ENV)


if __name__ == "__main__":
    unittest.main()
