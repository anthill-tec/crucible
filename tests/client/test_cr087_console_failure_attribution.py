"""CR-CRU-087 C2 -- `_parse_console_failures` leaf ATTRIBUTION, both orderings.

Per docs/changes/CR-CRU-087-ci-bun-is-unpinned.md §S2/§S3, AC3.

WHY THIS FILE EXISTS. `tests/clients-bun-crucible.test.ts` proves §S2c marrying
end-to-end (real client, real server, real `bun test`), but it can only observe
the ORDERING THE INSTALLED BUN HAPPENS TO PRINT. Its old timeout assertion
(`expect(timedOut?.failure?.message).toBeUndefined()`) defended an ABSENCE that
is an artifact of bun 1.3.14's line ordering -- a newer bun in CI produced
`"test timed out"` for the same leaf and the suite went red on the runner's bun
rather than on the code. AC3 moves the version-sensitive half down here, where
BOTH orderings are fixtures fed to the real function, so the suite's verdict
stops depending on which bun the runner installed.

WIRE FORMS. Both legal families documented at clients/bun-crucible.py:544-564
are exercised for every ordering:
  - the ANSI-colourised form bun emits EVEN THROUGH A PIPE
    (`\x1b[0m\x1b[31m<glyph>\x1b[0m\x1b[0m\x1b[1m name\x1b[0m ...`), and
  - the PLAIN `(fail)` / `(pass)` / `(skip)` / `(todo)` form (§S1b).
Nothing here is an invented shape: the helpers below reproduce bytes captured
from the installed `bun test` binary (1.3.14, 0d9b296a) piped to a file, and
REAL_LEAKED_ASYNC_ERROR_LOG_PLAIN is a verbatim such capture (only the scratch
directory in the two stack-trace paths was normalised).

THE DEFECT THIS MODULE MEASURED (out of scope for CR-087; fixed by CR-CRU-088).
`_parse_console_failures` USED TO reset its block on each result line and marry
a pending `error:` block to the NEXT `(fail)` line by position alone. So a
detail block that arrived AFTER its own leaf's fail line and BEFORE the next
leaf's fail line was married onto that LATER leaf -- a leaf that never produced
it. bun 1.3.14 prints exactly this shape whenever a test leaks an async throw:
alpha's `error: leaked boom` lands between alpha's `(fail)` line and beta's,
and `beta fails` came back carrying `"leaked boom"`. The fixture in
tests/clients-bun-crucible.test.ts never caught it because its only
after-the-fail-line detail belongs to the LAST test in the file, so there is no
later leaf to bleed onto. CR-CRU-088 §S1 fixed it in
`clients/bun-crucible.py::_parse_console_failures`.

THE FOUR ORDERING FIXTURES ARE CHARACTERISATIONS, NOT A RED. They pin behaviour
the production code already had, and they still pass against it -- the
CR-CRU-088 fix left them untouched. Their value is proven by MUTATION rather
than by a red run: making the `_RESULT_BOUNDARY_LINE` branch's block reset
unreachable in `clients/bun-crucible.py` fails
`test_ac3_a_result_boundary_line_ends_a_pending_block` in BOTH wire forms.

THE FORWARD-MARRYING GUARD NOW LIVES HERE. The defect described above is what
the parser did BEFORE CR-CRU-088. Telling "alpha's aftermath" from "beta's
prelude" looked like an open design question -- the two shapes are positionally
identical in bun's stream -- so CR-087 pinned the defect as a characterisation
instead of committing a red guard. CR-CRU-088 §S1 settled it by measurement: a
detail block is attributed to the test its own `at <anonymous>`/source echo
NAMES, and only falls back to the next `(fail)` line when it names no test. The
guard is therefore a real assertion now (see `ForwardMarryingGuardTest` below),
not a deferred candidate. The four ordering fixtures above it are unchanged by
the fix and remain the version-independence coverage AC3 moved down here.

No production code is touched by this file.

Module-loading convention copied from the sibling bun-client harnesses
(test_bun_crucible_axi_conventions.py et al): load `clients/bun-crucible.py` by
file path via `importlib`, never as a package (hyphenated filename).

Invocation:
    python3 -m unittest tests.client.test_cr087_console_failure_attribution -v
"""

import importlib.util
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"

# The SGR reset run that bun opens almost every colourised token with.
ESC = "\x1b[0m"

WIRE_FORMS = ("plain", "ansi")


def _load_client_module():
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_cr087_attribution", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── bun's two legal result-line wire forms (clients/bun-crucible.py:544-564) ──

def _fail_line(name, wire, duration_ms="0.13"):
    if wire == "plain":
        return f"(fail) {name} [{duration_ms}ms]"
    return (f"{ESC}\x1b[31m\u2717{ESC}{ESC}\x1b[1m {name}{ESC} "
            f"{ESC}\x1b[2m[{duration_ms}ms{ESC}\x1b[2m]{ESC}")


def _pass_line(name, wire, duration_ms="0.04"):
    if wire == "plain":
        return f"(pass) {name} [{duration_ms}ms]"
    return (f"{ESC}\x1b[32m\u2713{ESC}{ESC}\x1b[1m {name}{ESC} "
            f"{ESC}\x1b[2m[{duration_ms}ms{ESC}\x1b[2m]{ESC}")


def _skip_line(name, wire):
    # Skip/todo lines carry no duration tail.
    if wire == "plain":
        return f"(skip) {name}"
    return f"{ESC}\x1b[33m\u00bb{ESC}{ESC}\x1b[2m {name}{ESC}"


def _error_block(message, wire, at="/tmp/bun-fixture/sample.test.ts:2:107"):
    """bun's `error: <detail>` block: the prefix itself is colourised
    (`\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m `) and a stack frame follows."""
    if wire == "plain":
        return [f"error: {message}", f"      at <anonymous> ({at})"]
    return [
        f"{ESC}\x1b[31merror{ESC}\x1b[2m:{ESC} \x1b[1m{message}{ESC}",
        f"{ESC}      \x1b[2mat {ESC}{ESC}\x1b[2m<anonymous>{ESC}\x1b[2m ({at}){ESC}",
    ]


# Verbatim `bun test` (1.3.14, 0d9b296a) stdout+stderr, piped to a file, for:
#   test("alpha fails and leaks", () => {
#     setTimeout(() => { throw new Error("leaked boom"); }, 5);
#     expect(1).toBe(2);
#   });
#   test("beta fails", async () => {
#     await new Promise(r => setTimeout(r, 30));
#     expect(3).toBe(4);
#   });
# Only the scratch directory in the two `at <anonymous>` paths was normalised.
# `error: leaked boom` is ALPHA's leaked async throw, printed AFTER alpha's
# `(fail)` line and BEFORE beta's -- the exact shape the parser used to
# mis-marry FORWARD onto beta before CR-CRU-088 fixed it, so this capture is
# the real-bytes reproducer behind the guard test at the bottom of this file.
# The ANSI capture of the same run parses identically.
REAL_LEAKED_ASYNC_ERROR_LOG_PLAIN = """bun test v1.3.14 (0d9b296a)

unc.test.ts:
1 | import { expect, test } from "bun:test";
2 | test("alpha fails and leaks", () => { setTimeout(() => { throw new Error("leaked boom"); }, 5); expect(1).toBe(2); });
                                                                                                              ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/unc.test.ts:2:107)
(fail) alpha fails and leaks [0.13ms]
1 | import { expect, test } from "bun:test";
2 | test("alpha fails and leaks", () => { setTimeout(() => { throw new Error("leaked boom"); }, 5); expect(1).toBe(2); });
                                                                                          ^
error: leaked boom
      at <anonymous> (/tmp/bun-fixture/unc.test.ts:2:87)
(fail) beta fails [5.00ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [12.00ms]
"""


class ConsoleFailureOrderingFixturesTest(unittest.TestCase):
    """§S3/AC3 -- BOTH detail orderings, in BOTH wire forms, over the real
    `_parse_console_failures`. This is the version-independence the CR is for:
    whichever ordering the runner's bun prints, attribution is pinned here."""

    def setUp(self):
        self.module = _load_client_module()

    # ── ordering A: detail BEFORE the fail line (bun's assertion/throw shape) ──

    def test_ac3_detail_before_fail_line_marries_to_that_leaf(self):
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                log = "\n".join([
                    *_error_block("expect(received).toBe(expected)", wire),
                    _fail_line("alpha asserts wrongly", wire),
                    *_error_block("boom with detail", wire),
                    _fail_line("beta throws with detail", wire),
                ])
                details = self.module._parse_console_failures(log)
                self.assertEqual(
                    details.get("alpha asserts wrongly", {}).get("message"),
                    "expect(received).toBe(expected)",
                    f"§S2c: a detail block IMMEDIATELY BEFORE a `(fail)` line "
                    f"must marry to that leaf ({wire} wire form); got {details!r}",
                )
                self.assertEqual(
                    details.get("beta throws with detail", {}).get("message"),
                    "boom with detail",
                    f"§S2c: each leaf keeps its OWN preceding block "
                    f"({wire} wire form); got {details!r}",
                )

    def test_ac3_stored_values_are_ansi_stripped_in_both_wire_forms(self):
        """The marrying key and the stored message/trace are cleaned even though
        matching happens on the wire form -- junit leaf names carry no escapes,
        so a married key must not either."""
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                log = "\n".join([
                    *_error_block("boom with detail", wire),
                    _fail_line("suite > nested leaf", wire),
                ])
                details = self.module._parse_console_failures(log)
                for key, married in details.items():
                    self.assertNotIn("\x1b", key, f"key {key!r} kept SGR escapes")
                    self.assertNotIn("\x1b", married["message"])
                    self.assertNotIn("\x1b", married["trace"])
                # Nested describes print "suite > name"; the bare junit leaf
                # name is indexed too.
                self.assertEqual(
                    details.get("nested leaf", {}).get("message"), "boom with detail",
                    f"last-segment indexing lost ({wire}); got {details!r}")

    # ── ordering B: detail AFTER the fail line (bun's timeout/leak shape) ──

    def test_ac3_detail_after_fail_line_does_not_marry_backwards(self):
        """A block printed AFTER a leaf's own `(fail)` line is structurally not
        a preceding block, so that leaf stays unmatched. Pinned so the ordering
        is a FIXTURE rather than an accident of the installed bun."""
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                log = "\n".join([
                    _fail_line("alpha times out", wire, duration_ms="500.00"),
                    *_error_block("test timed out", wire),
                ])
                details = self.module._parse_console_failures(log)
                self.assertNotIn(
                    "alpha times out", details,
                    f"a trailing block must not marry backwards onto its own "
                    f"leaf ({wire} wire form); got {details!r}",
                )

    def test_ac3_a_result_boundary_line_ends_a_pending_block(self):
        """`(pass)`/`(skip)`/`(todo)` (and their ANSI glyphs) end the block, so
        an orphaned detail cannot cross a finished test. True before the
        CR-CRU-088 forward-marrying fix and unchanged by it -- pinned in both
        wire forms so it cannot regress."""
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                log = "\n".join([
                    _fail_line("alpha times out", wire, duration_ms="500.00"),
                    *_error_block("test timed out", wire),
                    _pass_line("gamma passes", wire),
                    _skip_line("delta skipped", wire),
                    _fail_line("beta asserts wrongly", wire),
                ])
                details = self.module._parse_console_failures(log)
                self.assertEqual(
                    details, {},
                    f"a boundary result line must discard the pending block "
                    f"({wire} wire form); got {details!r}",
                )


class ForwardMarryingGuardTest(unittest.TestCase):
    """GUARD, on the real bun 1.3.14 bytes captured in
    REAL_LEAKED_ASYNC_ERROR_LOG_PLAIN: a leaked async throw printed between two
    `(fail)` lines must NOT be married onto the later leaf.

    This was CR-087's characterisation of the defect (it asserted the wrong
    answer on purpose, as a tripwire). CR-CRU-088 §S1 fixed the parser -- a
    detail block is attributed to the test its source echo NAMES, falling back
    to the next `(fail)` line only when it names nothing -- so the tripwire has
    been flipped to the correct expectation in the same commit as the fix."""

    def setUp(self):
        self.module = _load_client_module()

    def test_a_leaked_async_throw_is_not_attributed_to_the_next_leaf(self):
        details = self.module._parse_console_failures(
            REAL_LEAKED_ASYNC_ERROR_LOG_PLAIN)
        # Alpha's OWN assertion detail, echoing alpha's source line, is its own.
        self.assertEqual(
            details.get("alpha fails and leaks", {}).get("message"),
            "expect(received).toBe(expected)",
            f"alpha's own preceding block must stay its own; got {details!r}",
        )
        # `leaked boom` is ALPHA's async throw, printed after alpha's `(fail)`
        # line and before beta's. beta never produced it, so beta must carry
        # nothing -- this is what reaches the INGESTED tree, not just the
        # parser's return value.
        self.assertIsNone(
            details.get("beta fails", {}).get("message"),
            f"a leaked async throw must not bleed forward onto the next leaf "
            f"(CR-CRU-088 §S1); got {details!r}",
        )
