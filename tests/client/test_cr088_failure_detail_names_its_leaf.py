"""CR-CRU-088 C1 -- the SHIPPED rule: a failure detail block belongs to the
test its ECHO NAMES.

Per docs/changes/CR-CRU-088-failure-detail-marries-the-wrong-leaf.md, §S1 (the
measured discriminator), §S2 (the withheld guard becomes real), §S3, AC1-AC7.

THIS MODULE SPECIFIES THE ATTRIBUTION RULE. Gates (a)-(f) state the rule the
change shipped and pass against it. Gates (g)-(l), added by cycle C3 after VERIFY
measured the shipped discriminator OVER-TIGHTENING, state the other half of the
same rule -- a failing leaf keeps its own message whatever SYNTAX declared it --
and FAIL today (see §S1 GAP 3 below). They are the C3 RED gates.
The rule lives in `clients/bun-crucible.py::_parse_console_failures` (lines
606-679) and landed in this same change, per CR-CRU-088 §S1. BEFORE it, the
parser married a pending `error:` block to the NEXT `(fail)` line by POSITION,
so a block that arrived after its own leaf's fail line -- a leaked async
throw's aftermath -- was handed to a later leaf that never produced it, and
Crucible stated a falsehood about which test failed and why.

WHY A SIBLING MODULE, NOT AN EXTENSION OF THE CR-087 FILE.
This module is the §S1 SPECIFICATION of the attribution rule, stated over twelve
verbatim bun captures ((a)-(l) below): the legitimate consecutive and nested
shapes, the leaked-async shapes the rule must refuse, the echoless fallback, and
the six declaration shapes whose own detail the shipped discriminator drops.
The sibling tests/client/test_cr087_console_failure_attribution.py holds the
ordering fixtures and the real-bytes forward-marrying guard
(`ForwardMarryingGuardTest`), which was flipped from a characterisation of the
old defect into a real guard in the same commit that shipped the fix. The two
concerns stay in separate modules: the rule's specification here, the ordering
fixtures and the real-capture regression guard there.

THE RULE UNDER TEST (§S1, measured on bun 1.3.14 / 0d9b296a, 2026-08-23).
bun prints the enclosing `N | test("<name>", …` source line above the caret for
every failure block, and the block's stack frame points into that same test's
body. So the block carries its PRODUCER's identity:
  - echo names X and the following `(fail)` line is X  -> marry to X (unchanged);
  - echo names X and the following `(fail)` line is Y  -> the block is X's
    AFTERMATH: it marries to NOBODY. X already carries its own message, so the
    aftermath is dropped rather than overwriting it;
  - no `test("…"` line in the echo -> fall back to the positional rule.

WHERE §S1 IS UNDER-SPECIFIED FOR SHAPES MEASURED HERE. Both gaps were DESIGN
decisions, settled by the shipped parser; this module records the measurement
and, for GAP 1, asserts only the outcome both readings agree on.

  GAP 1 -- WHICH `test("…")` LINE. §S1 says "the echo names test X" as if the
  echo named exactly one test. It does not. bun's echo window is a source
  WINDOW, so it routinely spans a test boundary and contains SEVERAL `test("…")`
  lines: in LEGIT_CONSECUTIVE below, beta's own prelude echo shows alpha's
  `test(` line (3) AND beta's (7); in LEGIT_NESTED it shows iota's (5) AND
  kappa's (9). A rule reading "the echo names X" literally, taking the FIRST
  such line, would read beta's own prelude as alpha's aftermath and DROP it --
  breaking AC2, the common case. The reading that matches every fixture here is
  "the LAST `test("…")` line at or above the caret", i.e. the innermost
  enclosing test. §S1 does not say this; the shipped parser does -- it keeps
  the LAST declaration echoed before the caret (`_ECHO_TEST_DECL` /
  `_ECHO_CARET`, clients/bun-crucible.py:590-597).

  GAP 2 -- BARE ECHO NAME vs COMPOSED FAIL-LINE KEY. Under nested describes the
  echo carries the BARE test name (`test("epsilon leaks after failing"`) while
  the `(fail)` line carries the COMPOSED key
  (`(fail) outer > inner > zeta fails later`). §S1's "the following `(fail)`
  line is X" does not say which side is normalised for the comparison. Measured:
  they are only comparable on the fail line's TRAILING `" > "` segment. This
  matters doubly because `_parse_console_failures` indexes BOTH the composed key
  and the bare trailing segment (clients/bun-crucible.py:656-657), so a
  mis-attribution under nesting poisons TWO keys.

  GAP 3 -- WHICH SYNTAX THE ECHO CAN NAME (the C3 RED gates, (g)-(l)). §S1's
  third clause reads "no `test("…")` line in the echo -> fall back to the
  positional rule", which presumes the echo either names the PRODUCER or names
  NOBODY. Measured on bun 1.3.14, there is a third outcome that §S1 does not
  admit: the echo names the WRONG test. Two mechanisms produce it.
    - A NAME THE PATTERN CANNOT READ. `_ECHO_TEST_DECL` needs a plain string
      literal on the same line as `test(`, so `test.each([…])(…)`, `it.each(…)`,
      `test(NAME, …)` and any declaration split across lines match nothing. That
      alone would be harmless -- it is exactly the documented fallback -- except
      that `window` (clients/bun-crucible.py:640) is ASSIGNED on every match and
      NEVER INVALIDATED. Because the echo window spans the test boundary (GAP 1),
      it still holds the PRECEDING test's name, so the block is attributed to a
      test that did not raise it and is discarded as that test's aftermath.
      The fallback never runs; the leaf loses its only message.
    - A NAME READ AS SOURCE RATHER THAN VALUE. A template-literal name yields
      the un-interpolated source and an escaped quote inside a plain literal
      truncates at the first inner quote, so the echo yields a name bun never
      reports. These two drop unconditionally, stale window or not.
  Six ordinary shapes, every one silent: the board shows a failing leaf with no
  reason, on every bun ingest in the fleet. CR-CRU-088's Risk section calls this
  over-tightening worse than the original defect, so (g)-(l) below pin the
  contract that survives both: a failing leaf carries ITS OWN message, and its
  predecessor keeps ITS OWN, whatever syntax declared either.

WIRE FORMS (AC3). Every gate runs over BOTH legal result-line families
documented at clients/bun-crucible.py:544-564 -- the ANSI-colourised `✗` form
bun emits even through a pipe, and the plain `(fail)` form. The ANSI fixtures
are NOT synthesised from the plain ones: each is an independent verbatim
capture of the same fixture project run under FORCE_COLOR=1.

FIXTURE PROVENANCE (AC7). Every constant below is VERBATIM `bun test` 1.3.14
(0d9b296a) stdout+stderr piped to a file, from a scratch project created with
`mktemp -d`. The ONLY edit is normalising that scratch directory to
`/tmp/bun-fixture/` in the echoed paths, exactly as the CR-087 module does.
Nothing here is hand-written output. (g)-(l) were captured the same way, one
scratch project per shape, plain and FORCE_COLOR=1 twins per capture. Because every assertion runs over fixtures,
the suite's verdict cannot flip with a toolchain bump -- the CR-087 lesson.

No production code is touched by this file.

Module-loading convention copied from the sibling bun-client harnesses: load
`clients/bun-crucible.py` by file path via `importlib`, never as a package
(hyphenated filename).

Invocation:
    python3 -m unittest tests.client.test_cr088_failure_detail_names_its_leaf -v
"""

import importlib.util
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"

# Both legal wire forms, per clients/bun-crucible.py:544-564 (AC3).
WIRE_FORMS = ("plain", "ansi")


def _load_client_module():
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_cr088_attribution", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _messages(details):
    """Compact {leaf: message} view, for readable assertion failures."""
    return {key: married.get("message") for key, married in details.items()}


# ── (a) LEGITIMATE, the COMMON case (AC2) ───────────────────────────────────
# Fixture (a), the consecutive-failure shape (echoed below as the scratch file
# `a`) — two consecutive failing tests, each printing its own
# prelude block:
#   3 | test("alpha asserts wrongly", () => { expect(1).toBe(2); });
#   7 | test("beta throws its own boom", () => { throw new Error("beta boom"); });
# (written multi-line; see the echo below for the real line numbers). The two
# messages are DELIBERATELY DISTINCT (`expect(received).toBe(expected)` vs
# `beta boom`) so a swap, a drop or a duplication is visible rather than
# masked by two identical strings.
#
# MEASURED, and §S1 does not mention it: beta's echo window contains TWO
# `test("…")` lines — alpha's (line 3) and beta's (line 7). See §S1 GAP 1 in
# the module docstring.

LEGIT_CONSECUTIVE_PLAIN = """bun test v1.3.14 (0d9b296a)

a.test.ts:
1 | import { expect, test } from "bun:test";
2 | 
3 | test("alpha asserts wrongly", () => {
4 |   expect(1).toBe(2);
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/a.test.ts:4:13)
(fail) alpha asserts wrongly [0.09ms]
3 | test("alpha asserts wrongly", () => {
4 |   expect(1).toBe(2);
5 | });
6 | 
7 | test("beta throws its own boom", () => {
8 |   throw new Error("beta boom");
                                 ^
error: beta boom
      at <anonymous> (/tmp/bun-fixture/a.test.ts:8:30)
(fail) beta throws its own boom [0.04ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [8.00ms]
"""

LEGIT_CONSECUTIVE_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "a.test.ts:\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36ma.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m4\x1b[0m\x1b[2m:\x1b[33m13\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m alpha asserts wrongly\x1b[0m \x1b[0m\x1b[2m[0.11ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m5 |\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m \n"
    "\x1b[0m\x1b[1m7 |\x1b[0m test(\x1b[0m\x1b[32m\"beta throws its own boom\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m8 |\x1b[0m   \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"beta boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                 \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mbeta boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36ma.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m8\x1b[0m\x1b[2m:\x1b[33m30\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m beta throws its own boom\x1b[0m \x1b[0m\x1b[2m[0.05ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m7.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

LEGIT_CONSECUTIVE = {"plain": LEGIT_CONSECUTIVE_PLAIN, "ansi": LEGIT_CONSECUTIVE_ANSI}


# ── (b) THE DEFECT, §S1's own measured shape (AC1) ──────────────────────────
# Fixture (b), the leaked-async multi-line shape (echoed below as the scratch
# file `b`) — `gamma` leaks an async throw and also asserts wrongly;
# `delta` fails 30ms later on its own assertion. bun prints gamma's assertion
# block, gamma's `(fail)` line, then GAMMA's leaked-throw block (its echo names
# gamma, its frame points at gamma's line 4), then DELTA's `(fail)` line.
# `delta fails later` never produced `leaked boom`.

LEAK_MULTILINE_PLAIN = """bun test v1.3.14 (0d9b296a)

b.test.ts:
1 | import { expect, test } from "bun:test";
2 | 
3 | test("gamma leaks after failing", () => {
4 |   setTimeout(() => { throw new Error("leaked boom"); }, 5);
5 |   expect(1).toBe(2);
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/b.test.ts:5:13)
(fail) gamma leaks after failing [0.13ms]
1 | import { expect, test } from "bun:test";
2 | 
3 | test("gamma leaks after failing", () => {
4 |   setTimeout(() => { throw new Error("leaked boom"); }, 5);
                                                      ^
error: leaked boom
      at <anonymous> (/tmp/bun-fixture/b.test.ts:4:51)
(fail) delta fails later [4.99ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [12.00ms]
"""

LEAK_MULTILINE_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "b.test.ts:\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"gamma leaks after failing\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   setTimeout(() => { \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"leaked boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m }, \x1b[0m\x1b[33m5\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m5 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mb.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m5\x1b[0m\x1b[2m:\x1b[33m13\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m gamma leaks after failing\x1b[0m \x1b[0m\x1b[2m[0.12ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"gamma leaks after failing\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   setTimeout(() => { \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"leaked boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m }, \x1b[0m\x1b[33m5\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                                      \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mleaked boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mb.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m4\x1b[0m\x1b[2m:\x1b[33m51\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m delta fails later\x1b[0m \x1b[0m\x1b[2m[4.99ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m13.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

LEAK_MULTILINE = {"plain": LEAK_MULTILINE_PLAIN, "ansi": LEAK_MULTILINE_ANSI}


# ── (c) THE DEFECT under NESTED describes (gate 5) ──────────────────────────
# Fixture (c), the nested-describe leak (echoed below as the scratch file `c`)
# — the (b) shape inside `describe("outer") >
# describe("inner")`. This is the case a naive name-match breaks: the ECHO
# names the BARE test (`epsilon leaks after failing`) while the `(fail)` line
# carries the COMPOSED key (`outer > inner > zeta fails later`). See §S1 GAP 2.

LEAK_NESTED_PLAIN = """bun test v1.3.14 (0d9b296a)

c.test.ts:
2 | 
3 | describe("outer", () => {
4 |   describe("inner", () => {
5 |     test("epsilon leaks after failing", () => {
6 |       setTimeout(() => { throw new Error("nested leaked boom"); }, 5);
7 |       expect(1).toBe(2);
                    ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/c.test.ts:7:17)
(fail) outer > inner > epsilon leaks after failing [0.11ms]
1 | import { describe, expect, test } from "bun:test";
2 | 
3 | describe("outer", () => {
4 |   describe("inner", () => {
5 |     test("epsilon leaks after failing", () => {
6 |       setTimeout(() => { throw new Error("nested leaked boom"); }, 5);
                                                                 ^
error: nested leaked boom
      at <anonymous> (/tmp/bun-fixture/c.test.ts:6:62)
(fail) outer > inner > zeta fails later [4.98ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [12.00ms]
"""

LEAK_NESTED_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "c.test.ts:\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m describe(\x1b[0m\x1b[32m\"outer\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   describe(\x1b[0m\x1b[32m\"inner\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m5 |\x1b[0m     test(\x1b[0m\x1b[32m\"epsilon leaks after failing\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m       setTimeout(() => { \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"nested leaked boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m }, \x1b[0m\x1b[33m5\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m7 |\x1b[0m       expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                    \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mc.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m7\x1b[0m\x1b[2m:\x1b[33m17\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m \x1b[0mouter\x1b[2m > \x1b[0minner\x1b[2m >\x1b[0m\x1b[1m epsilon leaks after failing\x1b[0m \x1b[0m\x1b[2m[0.13ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { describe, expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m describe(\x1b[0m\x1b[32m\"outer\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   describe(\x1b[0m\x1b[32m\"inner\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m5 |\x1b[0m     test(\x1b[0m\x1b[32m\"epsilon leaks after failing\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m       setTimeout(() => { \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"nested leaked boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m }, \x1b[0m\x1b[33m5\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                                                 \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mnested leaked boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mc.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m6\x1b[0m\x1b[2m:\x1b[33m62\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m \x1b[0mouter\x1b[2m > \x1b[0minner\x1b[2m >\x1b[0m\x1b[1m zeta fails later\x1b[0m \x1b[0m\x1b[2m[4.97ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m12.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

LEAK_NESTED = {"plain": LEAK_NESTED_PLAIN, "ansi": LEAK_NESTED_ANSI}


# ── (d) NO `test("…")` LINE IN THE ECHO — the fallback (gate 4) ─────────────
# Fixture (d), the echoless shared-helper shape (echoed below as the scratch
# file `d`) — both failures are thrown inside a shared helper defined
# at the top of the file, so bun's echo window shows the HELPER's source only;
# no `test("…")` line appears in either block. §S1's third clause says such a
# block falls back to the positional rule, so both leaves keep the message
# that rule gives them. Distinct messages (`helper boom for 5` / `… 10`) and
# distinct trace call-sites (`:11:3` / `:15:3`) make the pairing checkable.

ECHOLESS_HELPER_PLAIN = """bun test v1.3.14 (0d9b296a)

d.test.ts:
2 | 
3 | function throwsDeepInAHelper(value: number) {
4 |   const doubled = value * 2;
5 |   const tripled = value * 3;
6 |   const summed = doubled + tripled;
7 |   throw new Error(`helper boom for ${summed}`);
                                                 ^
error: helper boom for 5
      at throwsDeepInAHelper (/tmp/bun-fixture/d.test.ts:7:46)
      at <anonymous> (/tmp/bun-fixture/d.test.ts:11:3)
(fail) eta fails inside a helper [0.14ms]
2 | 
3 | function throwsDeepInAHelper(value: number) {
4 |   const doubled = value * 2;
5 |   const tripled = value * 3;
6 |   const summed = doubled + tripled;
7 |   throw new Error(`helper boom for ${summed}`);
                                                 ^
error: helper boom for 10
      at throwsDeepInAHelper (/tmp/bun-fixture/d.test.ts:7:46)
      at <anonymous> (/tmp/bun-fixture/d.test.ts:15:3)
(fail) theta fails inside a helper [0.03ms]

 0 pass
 2 fail
Ran 2 tests across 1 file. [7.00ms]
"""

ECHOLESS_HELPER_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "d.test.ts:\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m \x1b[0m\x1b[35mfunction\x1b[0m throwsDeepInAHelper(value: \x1b[0m\x1b[34mnumber\x1b[0m) {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   \x1b[0m\x1b[35mconst\x1b[0m doubled = value * \x1b[0m\x1b[33m2\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m5 |\x1b[0m   \x1b[0m\x1b[35mconst\x1b[0m tripled = value * \x1b[0m\x1b[33m3\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m   \x1b[0m\x1b[35mconst\x1b[0m summed = doubled + tripled\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m7 |\x1b[0m   \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m`helper boom for \x1b[0m${summed}\x1b[0m\x1b[32m`\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                                 \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mhelper boom for 5\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[1m\x1b[3mthrowsDeepInAHelper\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36md.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m7\x1b[0m\x1b[2m:\x1b[33m46\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36md.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m11\x1b[0m\x1b[2m:\x1b[33m3\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m eta fails inside a helper\x1b[0m \x1b[0m\x1b[2m[0.14ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m \x1b[0m\x1b[35mfunction\x1b[0m throwsDeepInAHelper(value: \x1b[0m\x1b[34mnumber\x1b[0m) {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   \x1b[0m\x1b[35mconst\x1b[0m doubled = value * \x1b[0m\x1b[33m2\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m5 |\x1b[0m   \x1b[0m\x1b[35mconst\x1b[0m tripled = value * \x1b[0m\x1b[33m3\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m   \x1b[0m\x1b[35mconst\x1b[0m summed = doubled + tripled\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m7 |\x1b[0m   \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m`helper boom for \x1b[0m${summed}\x1b[0m\x1b[32m`\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                                 \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mhelper boom for 10\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[1m\x1b[3mthrowsDeepInAHelper\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36md.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m7\x1b[0m\x1b[2m:\x1b[33m46\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36md.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m15\x1b[0m\x1b[2m:\x1b[33m3\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m theta fails inside a helper\x1b[0m \x1b[0m\x1b[2m[0.04ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m8.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

ECHOLESS_HELPER = {"plain": ECHOLESS_HELPER_PLAIN, "ansi": ECHOLESS_HELPER_ANSI}


# ── (e) LEGITIMATE under NESTED describes (gate 5, non-regression half) ─────
# Fixture (e), the legitimate nested shape (echoed below as the scratch file
# `e`) — the (a) shape inside `describe("outer") >
# describe("inner")`. Echo names the bare test, `(fail)` line carries the
# composed key, and the block IS the following leaf's own prelude. Also note
# the right-aligned gutter once line numbers reach two digits (` 5 |` … `10 |`).

LEGIT_NESTED_PLAIN = """bun test v1.3.14 (0d9b296a)

e.test.ts:
1 | import { describe, expect, test } from "bun:test";
2 | 
3 | describe("outer", () => {
4 |   describe("inner", () => {
5 |     test("iota asserts wrongly", () => {
6 |       expect(1).toBe(2);
                    ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/e.test.ts:6:17)
(fail) outer > inner > iota asserts wrongly [0.09ms]
 5 |     test("iota asserts wrongly", () => {
 6 |       expect(1).toBe(2);
 7 |     });
 8 | 
 9 |     test("kappa throws its own boom", () => {
10 |       throw new Error("kappa boom");
                                       ^
error: kappa boom
      at <anonymous> (/tmp/bun-fixture/e.test.ts:10:35)
(fail) outer > inner > kappa throws its own boom [0.04ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [7.00ms]
"""

LEGIT_NESTED_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "e.test.ts:\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { describe, expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m describe(\x1b[0m\x1b[32m\"outer\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   describe(\x1b[0m\x1b[32m\"inner\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m5 |\x1b[0m     test(\x1b[0m\x1b[32m\"iota asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m       expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                    \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36me.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m6\x1b[0m\x1b[2m:\x1b[33m17\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m \x1b[0mouter\x1b[2m > \x1b[0minner\x1b[2m >\x1b[0m\x1b[1m iota asserts wrongly\x1b[0m \x1b[0m\x1b[2m[0.10ms\x1b[0m\x1b[2m]\x1b[0m\n"
    " \x1b[0m\x1b[1m5 |\x1b[0m     test(\x1b[0m\x1b[32m\"iota asserts wrongly\"\x1b[0m, () => {\n"
    " \x1b[0m\x1b[1m6 |\x1b[0m       expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    " \x1b[0m\x1b[1m7 |\x1b[0m     })\x1b[0m\x1b[2m;\x1b[0m\n"
    " \x1b[0m\x1b[1m8 |\x1b[0m \n"
    " \x1b[0m\x1b[1m9 |\x1b[0m     test(\x1b[0m\x1b[32m\"kappa throws its own boom\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m10 |\x1b[0m       \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"kappa boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                       \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mkappa boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36me.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m10\x1b[0m\x1b[2m:\x1b[33m35\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m \x1b[0mouter\x1b[2m > \x1b[0minner\x1b[2m >\x1b[0m\x1b[1m kappa throws its own boom\x1b[0m \x1b[0m\x1b[2m[0.04ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m7.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

LEGIT_NESTED = {"plain": LEGIT_NESTED_PLAIN, "ansi": LEGIT_NESTED_ANSI}


# ── (f) THE DEFECT on AC1's literal bytes (alpha/beta) ─────────────────────
# Fixture (f), the one-liner leak (echoed below as the scratch file `f`) — the
# same source CR-087 captured as
# REAL_LEAKED_ASYNC_ERROR_LOG_PLAIN, recaptured here so this module is
# self-contained (AC7) and so the ANSI twin exists as real bytes too. AC1 names
# these two leaves: `beta fails` must carry NO message, `alpha fails and leaks`
# must keep `expect(received).toBe(expected)`.

LEAK_ONELINER_PLAIN = """bun test v1.3.14 (0d9b296a)

f.test.ts:
1 | import { expect, test } from "bun:test";
2 | test("alpha fails and leaks", () => { setTimeout(() => { throw new Error("leaked boom"); }, 5); expect(1).toBe(2); });
                                                                                                              ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/f.test.ts:2:107)
(fail) alpha fails and leaks [0.13ms]
1 | import { expect, test } from "bun:test";
2 | test("alpha fails and leaks", () => { setTimeout(() => { throw new Error("leaked boom"); }, 5); expect(1).toBe(2); });
                                                                                          ^
error: leaked boom
      at <anonymous> (/tmp/bun-fixture/f.test.ts:2:87)
(fail) beta fails [4.99ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [12.00ms]
"""

LEAK_ONELINER_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "f.test.ts:\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha fails and leaks\"\x1b[0m, () => { setTimeout(() => { \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"leaked boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m }, \x1b[0m\x1b[33m5\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                                                                                              \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mf.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m2\x1b[0m\x1b[2m:\x1b[33m107\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m alpha fails and leaks\x1b[0m \x1b[0m\x1b[2m[0.13ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha fails and leaks\"\x1b[0m, () => { setTimeout(() => { \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"leaked boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m }, \x1b[0m\x1b[33m5\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                                                                          \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mleaked boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mf.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m2\x1b[0m\x1b[2m:\x1b[33m87\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m beta fails\x1b[0m \x1b[0m\x1b[2m[4.98ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m12.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

LEAK_ONELINER = {"plain": LEAK_ONELINER_PLAIN, "ansi": LEAK_ONELINER_ANSI}


# ── (g) OVER-TIGHTENING: `test.each` (C3 RED) ───────────────────────────────
# Fixture (g), the `test.each` shape (echoed below as the scratch file `g`) — a
# plainly-declared failing test followed by a `test.each([…])("beta each %i", …)`
# that fails with its own distinct message:
#   3 | test("alpha asserts wrongly", () => {
#   7 | test.each([1])("beta each %i", (n) => {
#   8 |   throw new Error("beta each boom");
# MEASURED: bun expands `%i`, so the result line reads `(fail) beta each 1`,
# and beta's own prelude echo spans the boundary — it shows alpha's `test(` line
# (3) AND beta's `test.each(` line (7). `_ECHO_TEST_DECL` cannot read the
# `test.each([…])(…)` form (a `[` sits where the name literal would be), so the
# window is never overwritten and still holds `alpha asserts wrongly` when
# `error: beta each boom` arrives. The names disagree, the block is read as
# alpha's aftermath, and beta each 1 arrives with NO message at all.

EACH_TEST_PLAIN = """bun test v1.3.14 (0d9b296a)

g.test.ts:
1 | import { expect, test } from "bun:test";
2 | 
3 | test("alpha asserts wrongly", () => {
4 |   expect(1).toBe(2);
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/g.test.ts:4:13)
(fail) alpha asserts wrongly [0.12ms]
3 | test("alpha asserts wrongly", () => {
4 |   expect(1).toBe(2);
5 | });
6 | 
7 | test.each([1])("beta each %i", (n) => {
8 |   throw new Error("beta each boom");
                                      ^
error: beta each boom
      at <anonymous> (/tmp/bun-fixture/g.test.ts:8:35)
(fail) beta each 1 [0.04ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [8.00ms]
"""

EACH_TEST_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "g.test.ts:\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mg.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m4\x1b[0m\x1b[2m:\x1b[33m13\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m alpha asserts wrongly\x1b[0m \x1b[0m\x1b[2m[0.12ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m5 |\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m \n"
    "\x1b[0m\x1b[1m7 |\x1b[0m test\x1b[0m\x1b[3m\x1b[1m.each\x1b[0m([\x1b[0m\x1b[33m1\x1b[0m])(\x1b[0m\x1b[32m\"beta each %i\"\x1b[0m, (n) => {\n"
    "\x1b[0m\x1b[1m8 |\x1b[0m   \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"beta each boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                      \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mbeta each boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mg.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m8\x1b[0m\x1b[2m:\x1b[33m35\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m beta each 1\x1b[0m \x1b[0m\x1b[2m[0.05ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m8.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

EACH_TEST = {"plain": EACH_TEST_PLAIN, "ansi": EACH_TEST_ANSI}

# ── (h) OVER-TIGHTENING: `it.each` (C3 RED) ─────────────────────────────────
# Fixture (h), the `it.each` shape (echoed below as the scratch file `h`) — the
# (g) shape spelled with bun's `it` alias, because `_ECHO_TEST_DECL` accepts
# `test` and `it` alike and both must survive:
#   7 | it.each([2])("gamma each %i", (n) => {
#   8 |   throw new Error("gamma each boom");
# Same mechanism, same measured outcome: `(fail) gamma each 2` loses
# `gamma each boom`.

EACH_IT_PLAIN = """bun test v1.3.14 (0d9b296a)

h.test.ts:
1 | import { expect, test, it } from "bun:test";
2 | 
3 | test("alpha asserts wrongly", () => {
4 |   expect(1).toBe(2);
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/h.test.ts:4:13)
(fail) alpha asserts wrongly [0.11ms]
3 | test("alpha asserts wrongly", () => {
4 |   expect(1).toBe(2);
5 | });
6 | 
7 | it.each([2])("gamma each %i", (n) => {
8 |   throw new Error("gamma each boom");
                                       ^
error: gamma each boom
      at <anonymous> (/tmp/bun-fixture/h.test.ts:8:36)
(fail) gamma each 2 [0.05ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [8.00ms]
"""

EACH_IT_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "h.test.ts:\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test, it } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mh.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m4\x1b[0m\x1b[2m:\x1b[33m13\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m alpha asserts wrongly\x1b[0m \x1b[0m\x1b[2m[0.18ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m5 |\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m \n"
    "\x1b[0m\x1b[1m7 |\x1b[0m it\x1b[0m\x1b[3m\x1b[1m.each\x1b[0m([\x1b[0m\x1b[33m2\x1b[0m])(\x1b[0m\x1b[32m\"gamma each %i\"\x1b[0m, (n) => {\n"
    "\x1b[0m\x1b[1m8 |\x1b[0m   \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"gamma each boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                       \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mgamma each boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mh.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m8\x1b[0m\x1b[2m:\x1b[33m36\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m gamma each 2\x1b[0m \x1b[0m\x1b[2m[0.06ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m9.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

EACH_IT = {"plain": EACH_IT_PLAIN, "ansi": EACH_IT_ANSI}

# ── (i) OVER-TIGHTENING: a variable-named test (C3 RED) ─────────────────────
# Fixture (i), the variable-named shape (echoed below as the scratch file `i`) —
# the name is a `const`, the single most ordinary way a real suite parameterises
# a test name:
#   3 | const NAME = "delta named by a variable";
#   9 | test(NAME, () => {
#  10 |   throw new Error("delta boom");
# MEASURED: the result line carries the RESOLVED name
# (`(fail) delta named by a variable`) while the echo's `test(NAME,` line has no
# string literal to read, so the window still holds `alpha asserts wrongly`
# (line 5, inside the same six-line window) and delta's own block is discarded.
# Note also the right-aligned gutter once line numbers reach two digits.

VARIABLE_NAME_PLAIN = """bun test v1.3.14 (0d9b296a)

i.test.ts:
1 | import { expect, test } from "bun:test";
2 | 
3 | const NAME = "delta named by a variable";
4 | 
5 | test("alpha asserts wrongly", () => {
6 |   expect(1).toBe(2);
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/i.test.ts:6:13)
(fail) alpha asserts wrongly [0.14ms]
 5 | test("alpha asserts wrongly", () => {
 6 |   expect(1).toBe(2);
 7 | });
 8 | 
 9 | test(NAME, () => {
10 |   throw new Error("delta boom");
                                   ^
error: delta boom
      at <anonymous> (/tmp/bun-fixture/i.test.ts:10:31)
(fail) delta named by a variable [0.05ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [9.00ms]
"""

VARIABLE_NAME_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "i.test.ts:\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m \x1b[0m\x1b[35mconst\x1b[0m NAME = \x1b[0m\x1b[32m\"delta named by a variable\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m \n"
    "\x1b[0m\x1b[1m5 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mi.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m6\x1b[0m\x1b[2m:\x1b[33m13\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m alpha asserts wrongly\x1b[0m \x1b[0m\x1b[2m[0.13ms\x1b[0m\x1b[2m]\x1b[0m\n"
    " \x1b[0m\x1b[1m5 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    " \x1b[0m\x1b[1m6 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    " \x1b[0m\x1b[1m7 |\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n"
    " \x1b[0m\x1b[1m8 |\x1b[0m \n"
    " \x1b[0m\x1b[1m9 |\x1b[0m test(NAME, () => {\n"
    "\x1b[0m\x1b[1m10 |\x1b[0m   \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"delta boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                   \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mdelta boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mi.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m10\x1b[0m\x1b[2m:\x1b[33m31\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m delta named by a variable\x1b[0m \x1b[0m\x1b[2m[0.05ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m9.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

VARIABLE_NAME = {"plain": VARIABLE_NAME_PLAIN, "ansi": VARIABLE_NAME_ANSI}

# ── (j) OVER-TIGHTENING: a split declaration (C3 RED) ───────────────────────
# Fixture (j), the split-declaration shape (echoed below as the scratch file
# `j`) — the declaration spread over several source lines, as a formatter
# produces for any long name or option object:
#   3 | test("alpha asserts wrongly", () => { expect(1).toBe(2); });
#   5 | test(
#   6 |   "epsilon split over lines",
#   7 |   () => { throw new Error("epsilon boom"); },
# MEASURED: `test(` and the name literal sit on DIFFERENT lines, so the
# single-line `_ECHO_TEST_DECL` matches neither, and the window keeps alpha's
# name (line 3).
#
# PRECONDITION, measured: bun's echo window is the caret line plus the five
# above it. This shape only loses its message when the PRECEDING declaration
# still falls inside that window — spread the same declaration wider (bodies on
# their own lines, caret on line 10) and alpha's line 3 drops out of the window,
# the echo names nobody, the §S1 positional fallback takes over and the message
# survives. So the defect is not merely "this syntax", it is "this syntax within
# five lines of a readable declaration" — which is where test code normally is.

SPLIT_DECL_PLAIN = """bun test v1.3.14 (0d9b296a)

j.test.ts:
1 | import { expect, test } from "bun:test";
2 | 
3 | test("alpha asserts wrongly", () => { expect(1).toBe(2); });
                                                    ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/j.test.ts:3:49)
(fail) alpha asserts wrongly [0.09ms]
2 | 
3 | test("alpha asserts wrongly", () => { expect(1).toBe(2); });
4 | 
5 | test(
6 |   "epsilon split over lines",
7 |   () => { throw new Error("epsilon boom"); },
                                            ^
error: epsilon boom
      at <anonymous> (/tmp/bun-fixture/j.test.ts:7:41)
(fail) epsilon split over lines [0.04ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [8.00ms]
"""

SPLIT_DECL_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "j.test.ts:\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => { expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                                    \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mj.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m3\x1b[0m\x1b[2m:\x1b[33m49\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m alpha asserts wrongly\x1b[0m \x1b[0m\x1b[2m[0.12ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => { expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m \n"
    "\x1b[0m\x1b[1m5 |\x1b[0m test(\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m   \x1b[0m\x1b[32m\"epsilon split over lines\"\x1b[0m,\n"
    "\x1b[0m\x1b[1m7 |\x1b[0m   () => { \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"epsilon boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m },\n"
    "                                            \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mepsilon boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mj.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m7\x1b[0m\x1b[2m:\x1b[33m41\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m epsilon split over lines\x1b[0m \x1b[0m\x1b[2m[0.05ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m7.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

SPLIT_DECL = {"plain": SPLIT_DECL_PLAIN, "ansi": SPLIT_DECL_ANSI}

# ── (k) OVER-TIGHTENING: a template-literal name (C3 RED) ───────────────────
# Fixture (k), the template-literal shape (echoed below as the scratch file
# `k`) — the name is an interpolated template:
#   3 | const n = 3;
#   9 | test(`zeta ${n} interpolated`, () => {
#  10 |   throw new Error("zeta boom");
# MEASURED: `_ECHO_TEST_DECL` DOES match here — its quote class includes the
# backtick — but it lifts the UN-INTERPOLATED SOURCE, `zeta ${n} interpolated`,
# while the result line carries the evaluated `(fail) zeta 3 interpolated`. So
# the echo names a test that does not exist and the block is dropped
# UNCONDITIONALLY: unlike (g)-(j) this needs no stale window, because the name
# the echo yields can never equal the name bun reports.

TEMPLATE_NAME_PLAIN = """bun test v1.3.14 (0d9b296a)

k.test.ts:
1 | import { expect, test } from "bun:test";
2 | 
3 | const n = 3;
4 | 
5 | test("alpha asserts wrongly", () => {
6 |   expect(1).toBe(2);
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/k.test.ts:6:13)
(fail) alpha asserts wrongly [0.14ms]
 5 | test("alpha asserts wrongly", () => {
 6 |   expect(1).toBe(2);
 7 | });
 8 | 
 9 | test(`zeta ${n} interpolated`, () => {
10 |   throw new Error("zeta boom");
                                  ^
error: zeta boom
      at <anonymous> (/tmp/bun-fixture/k.test.ts:10:30)
(fail) zeta 3 interpolated [0.05ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [8.00ms]
"""

TEMPLATE_NAME_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "k.test.ts:\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m \x1b[0m\x1b[35mconst\x1b[0m n = \x1b[0m\x1b[33m3\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m \n"
    "\x1b[0m\x1b[1m5 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mk.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m6\x1b[0m\x1b[2m:\x1b[33m13\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m alpha asserts wrongly\x1b[0m \x1b[0m\x1b[2m[0.13ms\x1b[0m\x1b[2m]\x1b[0m\n"
    " \x1b[0m\x1b[1m5 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    " \x1b[0m\x1b[1m6 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    " \x1b[0m\x1b[1m7 |\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n"
    " \x1b[0m\x1b[1m8 |\x1b[0m \n"
    " \x1b[0m\x1b[1m9 |\x1b[0m test(\x1b[0m\x1b[32m`zeta \x1b[0m${n}\x1b[0m\x1b[32m interpolated`\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m10 |\x1b[0m   \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"zeta boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                  \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mzeta boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36mk.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m10\x1b[0m\x1b[2m:\x1b[33m30\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m zeta 3 interpolated\x1b[0m \x1b[0m\x1b[2m[0.05ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m7.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

TEMPLATE_NAME = {"plain": TEMPLATE_NAME_PLAIN, "ansi": TEMPLATE_NAME_ANSI}

# ── (l) OVER-TIGHTENING: an escaped quote in the name (C3 RED) ──────────────
# Fixture (l), the escaped-quote shape (echoed below as the scratch file `l`) —
# a perfectly ordinary plain string literal that happens to quote something:
#   7 | test("lambda says \"hi\" loudly", () => {
#   8 |   throw new Error("lambda boom");
# MEASURED: `_ECHO_TEST_DECL`'s non-greedy `(?P<name>.*?)(?P=q)` stops at the
# FIRST inner quote, so the echo name TRUNCATES to `lambda says \` while the
# result line carries the whole `(fail) lambda says "hi" loudly`. Dropped
# UNCONDITIONALLY, like (k), and for the same reason: the regex reads source
# text where it needs a value.

ESCAPED_QUOTE_PLAIN = r"""bun test v1.3.14 (0d9b296a)

l.test.ts:
1 | import { expect, test } from "bun:test";
2 | 
3 | test("alpha asserts wrongly", () => {
4 |   expect(1).toBe(2);
                ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bun-fixture/l.test.ts:4:13)
(fail) alpha asserts wrongly [0.10ms]
3 | test("alpha asserts wrongly", () => {
4 |   expect(1).toBe(2);
5 | });
6 | 
7 | test("lambda says \"hi\" loudly", () => {
8 |   throw new Error("lambda boom");
                                   ^
error: lambda boom
      at <anonymous> (/tmp/bun-fixture/l.test.ts:8:32)
(fail) lambda says "hi" loudly [0.04ms]

 0 pass
 2 fail
 1 expect() calls
Ran 2 tests across 1 file. [8.00ms]
"""

ESCAPED_QUOTE_ANSI = (
    "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n"
    "\x1b[0m\n"
    "l.test.ts:\n"
    "\x1b[0m\x1b[1m1 |\x1b[0m \x1b[0m\x1b[35mimport\x1b[0m { expect, test } \x1b[0m\x1b[35mfrom\x1b[0m \x1b[0m\x1b[32m\"bun:test\"\x1b[0m\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m2 |\x1b[0m \n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1m\x1b[2mexpect(\x1b[0m\x1b[31mreceived\x1b[0m\x1b[2m).\x1b[0mtoBe\x1b[2m(\x1b[0m\x1b[32mexpected\x1b[0m\x1b[2m)\x1b[0m\n"
    "\n"
    "Expected: \x1b[32m2\x1b[0m\n"
    "Received: \x1b[31m1\x1b[0m\n"
    "\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36ml.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m4\x1b[0m\x1b[2m:\x1b[33m13\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m alpha asserts wrongly\x1b[0m \x1b[0m\x1b[2m[0.11ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\x1b[0m\x1b[1m3 |\x1b[0m test(\x1b[0m\x1b[32m\"alpha asserts wrongly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m4 |\x1b[0m   expect(\x1b[0m\x1b[33m1\x1b[0m)\x1b[0m\x1b[3m\x1b[1m.toBe\x1b[0m(\x1b[0m\x1b[33m2\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m5 |\x1b[0m })\x1b[0m\x1b[2m;\x1b[0m\n"
    "\x1b[0m\x1b[1m6 |\x1b[0m \n"
    "\x1b[0m\x1b[1m7 |\x1b[0m test(\x1b[0m\x1b[32m\"lambda says \\\"hi\\\" loudly\"\x1b[0m, () => {\n"
    "\x1b[0m\x1b[1m8 |\x1b[0m   \x1b[0m\x1b[35mthrow\x1b[0m \x1b[0m\x1b[35mnew\x1b[0m \x1b[0m\x1b[1mError\x1b[0m(\x1b[0m\x1b[32m\"lambda boom\"\x1b[0m)\x1b[0m\x1b[2m;\x1b[0m\n"
    "                                   \x1b[31m\x1b[1m^\x1b[0m\n"
    "\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mlambda boom\x1b[0m\n"
    "\x1b[0m      \x1b[2mat \x1b[0m\x1b[0m\x1b[2m<anonymous>\x1b[0m\x1b[2m (\x1b[0m\x1b[0m\x1b[36m\x1b[2m/tmp/bun-fixture/\x1b[0m\x1b[36ml.test.ts\x1b[0m\x1b[2m:\x1b[0m\x1b[33m8\x1b[0m\x1b[2m:\x1b[33m32\x1b[0m\x1b[2m)\x1b[0m\n"
    "\x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m lambda says \"hi\" loudly\x1b[0m \x1b[0m\x1b[2m[0.04ms\x1b[0m\x1b[2m]\x1b[0m\n"
    "\n"
    " 0 pass\x1b[0m\n"
    "\x1b[0m\x1b[31m 2 fail\x1b[0m\n"
    " 1 expect() calls\n"
    "Ran 2 tests across 1 file. \x1b[0m\x1b[2m[\x1b[1m8.00ms\x1b[0m\x1b[2m]\x1b[0m\n"
    ""
)

ESCAPED_QUOTE = {"plain": ESCAPED_QUOTE_PLAIN, "ansi": ESCAPED_QUOTE_ANSI}


# Every (g)-(l) fixture pairs the shape under test with the SAME plainly-declared
# predecessor, so the only variable across the six is the producing test's
# declaration syntax.
SHAPED_PREDECESSOR = "alpha asserts wrongly"
SHAPED_PREDECESSOR_MESSAGE = "expect(received).toBe(expected)"


class _ParserCase(unittest.TestCase):
    """Shared plumbing: the real `_parse_console_failures`, no test doubles."""

    def setUp(self):
        self.module = _load_client_module()

    def parse(self, capture, wire):
        return self.module._parse_console_failures(capture[wire])

    def assertMessage(self, details, leaf, expected, why):
        self.assertEqual(
            details.get(leaf, {}).get("message"), expected,
            f"{why}\n  leaf={leaf!r}\n  parsed={_messages(details)!r}")

    def assertNoMessage(self, details, leaf, why):
        self.assertIsNone(
            details.get(leaf, {}).get("message"),
            f"{why}\n  leaf={leaf!r}\n  parsed={_messages(details)!r}")


class AftermathDoesNotMarryForwardTest(_ParserCase):
    """AC1 -- a block whose echo names test X never marries onto a later leaf Y.

    Both assertions FAILED before the §S1 fix -- the parser handed X's
    aftermath to Y -- and now pin the shipped behaviour.
    """

    def test_ac1_oneliner_leak_aftermath_is_not_handed_to_the_next_leaf(self):
        """AC1's literal wording, on the real captured bytes: `beta fails`
        carries NO message and `alpha fails and leaks` keeps its own."""
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                details = self.parse(LEAK_ONELINER, wire)
                self.assertMessage(
                    details, "alpha fails and leaks",
                    "expect(received).toBe(expected)",
                    "AC1/§S1: the producing leaf keeps its OWN message -- the "
                    "aftermath is dropped, never allowed to overwrite it "
                    f"({wire} wire form).")
                self.assertNoMessage(
                    details, "beta fails",
                    "AC1/§S1: `error: leaked boom` is ALPHA's aftermath -- its "
                    "echo names alpha and its frame points into alpha's body. "
                    "beta never produced it, so beta must carry no message "
                    f"({wire} wire form).")

    def test_ac1_multiline_leak_aftermath_is_not_handed_to_the_next_leaf(self):
        """§S1's own measured fixture (gamma/delta), where the echo's `test("…"`
        line and the caret sit on SEPARATE source lines -- the normal shape of
        real test code, unlike the one-liner above."""
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                details = self.parse(LEAK_MULTILINE, wire)
                self.assertMessage(
                    details, "gamma leaks after failing",
                    "expect(received).toBe(expected)",
                    "AC1/§S1: gamma keeps its own assertion message "
                    f"({wire} wire form).")
                self.assertNoMessage(
                    details, "delta fails later",
                    "AC1/§S1: the second block's echo names GAMMA (line 3) and "
                    "its frame points at gamma's line 4; delta's body starts at "
                    "line 8. The block is gamma's aftermath and must marry to "
                    f"nobody ({wire} wire form).")


class CommonCaseNonRegressionTest(_ParserCase):
    """AC2 -- the case that is MORE COMMON than the defect: two consecutive
    failing tests, each with its own prelude block, each keeping its own
    message. This is the assertion that fails if a fix over-tightens into
    "discard anything printed after a fail line", which would silently blank the
    message on every leaf but the first of every red suite. It must be
    unmissable.

    Green before the §S1 fix and green after it; it must STAY green."""

    def test_ac2_two_consecutive_failures_each_keep_their_own_message(self):
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                details = self.parse(LEGIT_CONSECUTIVE, wire)
                self.assertMessage(
                    details, "alpha asserts wrongly",
                    "expect(received).toBe(expected)",
                    "AC2: the first leaf's own prelude block must marry to it "
                    f"({wire} wire form).")
                self.assertMessage(
                    details, "beta throws its own boom", "beta boom",
                    "AC2 REGRESSION GUARD: beta's block IS beta's own prelude "
                    "-- its caret sits inside beta's body -- even though the "
                    "echo window also shows alpha's `test(` line (§S1 GAP 1). "
                    "A fix that drops every block following a fail line, or one "
                    "that attributes by the FIRST `test(\"…\")` line in the "
                    "echo, blanks this and breaks the normal red suite "
                    f"({wire} wire form).")

    def test_ac2_the_two_leaves_do_not_share_a_message(self):
        """A cross-check that survives any future edit to the expectations: two
        independently-failing leaves must not end up carrying the SAME detail,
        which is the observable signature of both over-marrying and
        under-marrying."""
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                details = self.parse(LEGIT_CONSECUTIVE, wire)
                alpha = details.get("alpha asserts wrongly", {}).get("message")
                beta = details.get("beta throws its own boom", {}).get("message")
                self.assertNotEqual(
                    alpha, beta,
                    "AC2: each leaf must carry ITS OWN message; identical "
                    f"messages mean one block was married twice ({wire} wire "
                    f"form); parsed={_messages(details)!r}")


class EcholessFallbackTest(_ParserCase):
    """§S1's third clause -- a block with no `test("…")` line in its echo still
    marries POSITIONALLY, so shapes the echo does not cover keep exactly the
    pre-CR-088 positional behaviour. Asserted so the fallback is a CONTRACT
    rather than an accident.

    Green before the §S1 fix and green after it; it must STAY green."""

    def test_echoless_block_still_marries_to_the_following_leaf(self):
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                details = self.parse(ECHOLESS_HELPER, wire)
                self.assertMessage(
                    details, "eta fails inside a helper", "helper boom for 5",
                    "§S1 fallback: the echo shows only the shared helper's "
                    "source -- no `test(\"…\")` line -- so the positional rule "
                    f"stands ({wire} wire form).")
                self.assertMessage(
                    details, "theta fails inside a helper", "helper boom for 10",
                    "§S1 fallback: the SECOND echo-less block must still marry "
                    "to the leaf that follows it. Dropping it because it comes "
                    "after a fail line would lose detail the parser gets right "
                    f"today ({wire} wire form).")

    def test_echoless_blocks_keep_their_own_call_site_traces(self):
        """The two blocks are distinguishable only by their call-site frame, so
        pin that the RIGHT trace lands on the right leaf -- a positional
        fallback that merely preserves the messages while swapping the traces
        would still be wrong."""
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                details = self.parse(ECHOLESS_HELPER, wire)
                self.assertIn(
                    "d.test.ts:11:3",
                    details.get("eta fails inside a helper", {}).get("trace", ""),
                    "§S1 fallback: eta's trace must be eta's call site "
                    f"({wire} wire form); parsed={_messages(details)!r}")
                self.assertIn(
                    "d.test.ts:15:3",
                    details.get("theta fails inside a helper", {}).get("trace", ""),
                    "§S1 fallback: theta's trace must be theta's call site "
                    f"({wire} wire form); parsed={_messages(details)!r}")


class NestedDescribeAttributionTest(_ParserCase):
    """The rule under nested describes -- the shape most likely to break a naive
    name-matching implementation, because the echo names the BARE test while the
    `(fail)` line carries the COMPOSED `suite > name` key, and
    `_parse_console_failures` indexes BOTH (clients/bun-crucible.py:656-657).
    Decidable from bun's bytes: measured, the echo's bare name and the fail
    line's trailing segment line up exactly (see §S1 GAP 2 for what §S1 leaves
    open)."""

    def test_nested_aftermath_is_not_handed_to_the_next_nested_leaf(self):
        """Before the §S1 fix the nested aftermath poisoned BOTH of zeta's
        keys; now neither carries it."""
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                details = self.parse(LEAK_NESTED, wire)
                self.assertMessage(
                    details, "outer > inner > epsilon leaks after failing",
                    "expect(received).toBe(expected)",
                    "§S1: the producing nested leaf keeps its own message "
                    f"({wire} wire form).")
                self.assertMessage(
                    details, "epsilon leaks after failing",
                    "expect(received).toBe(expected)",
                    "§S1: the bare-segment index of the producing leaf is kept "
                    f"too ({wire} wire form).")
                self.assertNoMessage(
                    details, "outer > inner > zeta fails later",
                    "§S1: `error: nested leaked boom` is EPSILON's aftermath -- "
                    "its echo names `epsilon leaks after failing` and its frame "
                    "points at epsilon's line 6. It must not marry onto zeta's "
                    f"composed key ({wire} wire form).")
                self.assertNoMessage(
                    details, "zeta fails later",
                    "§S1: nor onto zeta's BARE-segment index -- a "
                    "mis-attribution under nesting poisons two keys, so a fix "
                    "that guards only the composed key still lies to any "
                    f"consumer keyed on the junit leaf name ({wire} wire form).")

    def test_nested_common_case_each_leaf_keeps_its_own_message(self):
        """AC2 under nesting: the block IS the following nested leaf's own
        prelude, so it must still marry -- on both indexed keys.

        Green before the §S1 fix and green after it; it must STAY green."""
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                details = self.parse(LEGIT_NESTED, wire)
                self.assertMessage(
                    details, "outer > inner > iota asserts wrongly",
                    "expect(received).toBe(expected)",
                    f"AC2 under nesting: iota's own prelude ({wire} wire form).")
                self.assertMessage(
                    details, "outer > inner > kappa throws its own boom",
                    "kappa boom",
                    "AC2 under nesting: kappa's block is kappa's OWN prelude. "
                    "The echo names the BARE `kappa throws its own boom` while "
                    "the fail line carries the composed key, so a fix comparing "
                    "the echo against the WHOLE fail-line name -- rather than "
                    "its trailing segment -- reads this as an aftermath and "
                    f"blanks it ({wire} wire form).")
                self.assertMessage(
                    details, "kappa throws its own boom", "kappa boom",
                    "AC2 under nesting: the bare-segment index must marry too "
                    f"({wire} wire form).")


class ShapedDeclarationKeepsItsOwnMessageTest(_ParserCase):
    r"""§S1 OVER-TIGHTENING -- a failing leaf keeps its own message whatever
    SYNTAX declared it.

    The §S1 discriminator compares the name the echo yields against the
    following result line's name and, on disagreement, DISCARDS the block as an
    aftermath. That comparison is sound only when the echo actually yields the
    producing test's name. Measured on bun 1.3.14, it does not for six ordinary
    declaration shapes, in two distinct ways:

      - `test.each`, `it.each`, a variable name and a split declaration yield NO
        name at all -- and `window` (clients/bun-crucible.py:640, 671-675) is
        ASSIGNED on every declaration match but NEVER INVALIDATED, so it still
        holds the PRECEDING test's name from the same six-line echo window
        (§S1 GAP 1's window really does span the boundary; here that is not a
        harmless surplus, it is a wrong answer);
      - a template-literal name and a name containing an escaped quote yield the
        WRONG name -- the regex reads SOURCE TEXT (`zeta ${n} interpolated`,
        `lambda says \`) where it needs the VALUE bun reports (`zeta 3
        interpolated`, `lambda says "hi" loudly`). These two drop
        unconditionally, with no stale window required.

    Either way the names disagree and the producer's OWN prelude block -- the
    only place bun ever prints its reason -- is thrown away. The leaf still shows
    as failing, with no reason: a silent hole on every bun ingest in the fleet
    (`_marry_failures`, clients/bun-crucible.py:682-699). CR-CRU-088's own Risk
    section names this over-tightening the worse outcome of the two, and the six
    C1 fixtures cannot see it because every one of them declares its tests as a
    plain, single-line, double-quoted literal.

    THE CONTRACT ASSERTED, once per shape: the producing leaf carries ITS OWN
    message, the predecessor carries ITS OWN, and the two differ -- so a swap is
    as detectable as a drop.
    """

    def assertBothLeavesKeepTheirOwn(self, capture, leaf, message, shape):
        """The shared contract for (g)-(l): two independently-failing leaves,
        two distinct messages, each on its own leaf."""
        for wire in WIRE_FORMS:
            with self.subTest(wire=wire):
                details = self.parse(capture, wire)
                self.assertMessage(
                    details, leaf, message,
                    f"§S1 OVER-TIGHTENING ({shape}): this leaf FAILED and bun "
                    "printed its reason, so the leaf must carry it. The echo "
                    "above that block does not name this leaf -- so the §S1 "
                    "discriminator reads the leaf's OWN prelude as somebody "
                    "else's aftermath and discards the only detail that exists "
                    f"({wire} wire form).")
                self.assertMessage(
                    details, SHAPED_PREDECESSOR, SHAPED_PREDECESSOR_MESSAGE,
                    f"§S1 ({shape}): the PRECEDING leaf, plainly declared, must "
                    "keep its own message -- the fix for the shape above must "
                    f"not be bought by breaking the ordinary case ({wire} wire "
                    "form).")
                self.assertNotEqual(
                    details.get(leaf, {}).get("message"),
                    details.get(SHAPED_PREDECESSOR, {}).get("message"),
                    f"§S1 ({shape}): the two leaves failed for DIFFERENT "
                    "reasons, so they must carry different messages; equal "
                    "messages mean the predecessor's block was married twice "
                    f"({wire} wire form); parsed={_messages(details)!r}")

    def test_each_declared_test_keeps_its_own_message(self):
        """(g) `test.each([1])("beta each %i", …)` -- `_ECHO_TEST_DECL` cannot
        read the `.each([…])(…)` form, so the window keeps alpha's name."""
        self.assertBothLeavesKeepTheirOwn(
            EACH_TEST, "beta each 1", "beta each boom", "test.each")

    def test_each_declared_it_keeps_its_own_message(self):
        """(h) the same through bun's `it` alias, which `_ECHO_TEST_DECL`
        accepts equally, so it must be covered equally."""
        self.assertBothLeavesKeepTheirOwn(
            EACH_IT, "gamma each 2", "gamma each boom", "it.each")

    def test_variable_named_test_keeps_its_own_message(self):
        """(i) `const NAME = "…"; test(NAME, …)` -- the echo has no literal to
        read while the result line carries the resolved name."""
        self.assertBothLeavesKeepTheirOwn(
            VARIABLE_NAME, "delta named by a variable", "delta boom",
            "variable name")

    def test_split_declaration_keeps_its_own_message(self):
        """(j) a declaration spread over several source lines, as a formatter
        produces -- `test(` and the name literal never share a line, so the
        single-line echo pattern matches neither."""
        self.assertBothLeavesKeepTheirOwn(
            SPLIT_DECL, "epsilon split over lines", "epsilon boom",
            "split declaration")

    def test_template_literal_named_test_keeps_its_own_message(self):
        """(k) an interpolated template name -- the echo yields the
        UN-INTERPOLATED SOURCE, which can never equal the name bun reports, so
        this one drops with no stale window involved."""
        self.assertBothLeavesKeepTheirOwn(
            TEMPLATE_NAME, "zeta 3 interpolated", "zeta boom",
            "template-literal name")

    def test_escaped_quote_in_name_keeps_its_own_message(self):
        """(l) a plain literal containing an escaped quote -- the non-greedy
        name group stops at the first inner quote and truncates the echo name.
        Also unconditional."""
        self.assertBothLeavesKeepTheirOwn(
            ESCAPED_QUOTE, 'lambda says "hi" loudly', "lambda boom",
            "escaped quote in name")


if __name__ == "__main__":
    unittest.main(verbosity=2)
