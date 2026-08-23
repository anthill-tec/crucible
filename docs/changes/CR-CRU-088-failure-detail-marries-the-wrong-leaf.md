# CR-CRU-088 — a failure detail printed after its own leaf is attributed to the NEXT test

- **Type**: bugfix
- **Wave**: 5
- **Depends on**: 087
- **Status**: PENDING

## Problem

`_parse_console_failures` (`clients/bun-crucible.py:587-631`) marries bun's console `error:` block to
the **next** `(fail)` line, because bun's JUnit reporter emits a bare `<failure type="…"/>` and the
human detail exists only on the console stream.

When a detail block arrives **after** its own leaf's `(fail)` line and **before** the next leaf's, it is
married onto that **later** leaf — a leaf that never produced it.

**Measured on real bun 1.3.14 output, not hypothetical.** A test that leaks an async throw:

```js
test("alpha fails and leaks", () => { setTimeout(() => { throw new Error("leaked boom"); }, 5); expect(1).toBe(2); });
test("beta fails", async () => { await new Promise(r => setTimeout(r, 30)); expect(3).toBe(4); });
```

bun prints `error: expect(...)` → `(fail) alpha fails and leaks` → `error: leaked boom` →
`(fail) beta fails`, and the real parser returns:

```
{'alpha fails and leaks': 'expect(received).toBe(expected)', 'beta fails': 'leaked boom'}
```

**It is not confined to the parser.** The wrong message reaches the **ingested tree**, so Crucible
reports one test's failure as another's — the board states a falsehood about which test failed and why.
For an evidence system that is the most damaging class of defect available: the data looks complete and
is wrong.

**Why CR-087 did not fix it.** CR-087 pinned the halves that DO work (a `(pass)`/`(skip)`/`(todo)`
boundary ends a pending block; a trailing block never marries backwards) and left this one out of
scope rather than commit a red guard, because the fix needs a **discriminator that bun's stream does
not obviously provide**: "alpha's aftermath" and "beta's prelude" occupy the same position between the
same two `(fail)` lines. Choosing that discriminator is a design decision, which is why this is its own
CR.

**The reproducer is already in the tree** (CR-087, merged): `tests/client/test_cr087_console_failure_attribution.py`
— `test_characterisation_leaked_async_throw_bleeds_forward_onto_next_leaf`, over the verbatim capture
`REAL_LEAKED_ASYNC_ERROR_LOG_PLAIN`. It asserts the CURRENT, DEFECTIVE attribution and is labelled
"CHARACTERISATION, NOT A SPECIFICATION", so the fix trips it **by design** — flipping it is part of
this CR's work, not collateral.

## Scope

### §S1 Choose the discriminator on evidence, not preference

The candidates, to be settled by MEASURING bun's real output before any parser change — the CR is not
authorised to guess:

1. **Stack-trace correlation.** An aftermath block's `at <anonymous> (<file>:<line>:<col>)` frame points
   at the leaf that *produced* it. If a leaf's own source location is knowable (junit `file`/`classname`,
   or the `N | <source>` echo bun prints above the caret), a block whose frame disagrees with the leaf
   it would marry is an aftermath block and must not marry forward.
2. **A structured reporter.** If the installed bun exposes a machine-readable failure stream, the
   console heuristic is replaced by it and the whole class disappears. Must be checked against the
   pinned version (CR-087 fixed it at `bun@1.3.14`), never assumed from release notes.
3. **Adjacency.** Whether bun separates an aftermath block from the next test's prelude in a way that
   is stable (blank line, indentation, ordering relative to the source echo) — cheapest if it holds,
   worthless if it is incidental to one version.

The chosen rule is recorded here before implementation, with the measurement that chose it.

### §S2 The withheld guard becomes real

CR-087 measured the defect and deliberately did not commit its guard tests. They land here: a detail
block never marries onto a later leaf, asserted in **both** documented wire forms (ANSI and plain), over
bun's real captured bytes as well as synthetic fixtures.

### §S3 The characterisation is replaced, deliberately

`test_characterisation_leaked_async_throw_bleeds_forward_onto_next_leaf` asserts today's wrong answer.
This CR replaces it with the correct expectation in the same commit as the fix, so the change of
behaviour is explicit in the diff rather than a test quietly disappearing.

## Acceptance criteria

- **AC1** — on the real captured bytes, `beta fails` carries **no** message and `alpha fails and leaks`
  keeps its own (`expect(received).toBe(expected)`). The leaked throw is attributed to alpha or dropped
  — never handed to beta.
- **AC2** — **no regression on the common case**: two consecutive failing tests that each print their
  own prelude block still receive their own messages. This is the case a naive "discard anything after a
  fail line" fix breaks, and it is more common than the defect.
- **AC3** — both wire forms (ANSI-coloured `✗` and plain `(fail)`) behave identically, per the forms
  documented at `clients/bun-crucible.py:544-564`.
- **AC4** — the fix holds end-to-end: the **ingested tree** (not just the parser's dict) reports each
  leaf's own failure message, asserted through the real client against a real server as
  `tests/clients-bun-crucible.test.ts` already does.
- **AC5** — CR-087's characterisation test is replaced by the guard in the same commit as the
  production change, and the module's docstring no longer describes an unfixed defect.
- **AC6** — the discriminator's evidence is recorded in this spec (§S1) before the GREEN phase, naming
  the bun version it was measured on.
- **AC7** — no dependence on which bun the runner installed: every assertion runs over fixtures, so the
  suite's verdict cannot flip with a toolchain bump (the CR-087 lesson).

## Estimated size

M — the parser change is small, but §S1's measurement pass and AC2's non-regression evidence are the
bulk of the work, and this touches the one function every stack's failure detail flows through.

## Risk

**Over-tightening is worse than the bug.** Discarding any block that follows a fail line would fix
AC1 and break AC2 — two consecutive failing tests, each with its own prelude, is the normal shape of a
red suite. AC2 exists to make that regression impossible to ship.

The blast radius is the whole bun ingest path: every RED/GREEN run of every bun cycle reports through
this function. A wrong fix silently degrades all future failure evidence, which is why AC4 asserts
through the real client rather than the parser alone.

## Non-goals

- The other clients' parsers (python/mvn/rust/arduino) — none parses bun's console form.
- Changing what bun prints, or requiring a newer bun. The pin is CR-087's; this CR works with it.
- Widening to bun's `error:` handling outside failure marrying (e.g. compile diagnostics).
