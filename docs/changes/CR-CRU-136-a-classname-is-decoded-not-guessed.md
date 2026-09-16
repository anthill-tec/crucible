# CR-CRU-136 — a classname is decoded, not guessed

**Type** fix · **Wave** 6 (0.2.0) · **Depends on** CR-CRU-133 · **Status** PENDING

## Problem

`tests/help-surface-order-independence.test.ts`'s `caseKey` helper (added by CR-CRU-133 §S4)
extracts which required file a JUnit `<testcase>` belongs to by splitting its `classname`
attribute on the literal string `"&amp;gt;"` — a guessed, hardcoded escaping of bun's describe-path
separator, not a real XML-entity decode.

Measured on GitHub Actions CI, `release/0.2.0` @ `4cda68f` (run 35067160128, `test-bun` job): the
guard's own `console.error` line reports `order=tests/roadmap-visual-grammar.test.ts(91) then
tests/project-namespace-tripwire.test.ts(21) failed=0` — the wrapper mechanism CR-133 §S4 built is
working exactly as designed: correct order, correct counts, nothing failed — yet `helpTest=NaNms`
and the guard fails asserting `helpTestRan: false`. The specific named testcase
(`HELP_TEST_NAME`) is present among the 21 registered cases (the file's own test count is intact);
`caseKey`'s classname split simply fails to produce the expected key string on the runner that
produced this report, even though the same bun build (`1.3.14`, `0d9b296a`) produced both the
passing local reports and this failing CI one.

The guard's OWN docstring names this exact risk in advance ("IT PINS THAT RUNNER'S JUNIT FORMAT
TOO... None can fail quietly... suspect the reporter's format before suspecting a starved run") —
this is that failure mode, not a starved run: `elapsed=31825ms` is within the healthy range measured
during CR-133 §S4 (32.6-32.9s locally), so nothing hung or timed out.

## Scope

### §S1 The classname's describe-path separator is decoded, not string-matched

Replace the literal `"&amp;gt;"` split with a real XML-entity decode of the `classname` attribute
(handling `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` in the correct order — `&amp;` decoded LAST,
so a double-escaped ampersand does not decode twice) followed by a split on the actual separator
bun's junit reporter uses between describe segments. Verify the real separator and escaping bun
1.3.14 emits by INSPECTING an actual generated report — the two names committed by CR-133's own FIX
round — rather than assuming the escaping this CR's Problem section measured is the only shape bun
ever emits.

## Acceptance criteria

- [ ] The guard passes on GitHub Actions CI (`release/0.2.0`'s `test-bun` job), not only locally —
      verified by pushing and observing an actual CI run, not by local re-verification alone.
- [ ] No existing assertion in the file is weakened: the order check, the outcome/failure check, the
      two non-vacuity floors, and both duration budgets all still check what they checked before.
- [ ] The negative control CR-133's FIX round already ran (deliberately breaking the forced order and
      confirming the guard fails correctly) is re-run and still passes after this fix.
- [ ] No production code (`src/`, `clients/`) touched — test-file-only change.

## Non-goals

- Re-litigating CR-133 §S4's order-forcing mechanism itself, which the CI evidence shows is working
  correctly. This CR fixes only the classname-to-file attribution step downstream of it.
