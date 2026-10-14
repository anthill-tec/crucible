# CR-CRU-189 — every subtest is counted, pass or fail

**Type** fix (patch CR) · **Points** 3 (set at filing, 2026-10-14) · **Wave** 8 (0.4.0) · **Depends
on** — · **Status** PENDING — filed 2026-10-14 (user ruling: a patch CR, next after CR-CRU-188)

## Problem

Noticed by the user (2026-10-14): when every test passes, the total a python run reports is smaller
than the total the same tests report when some fail.

Confirmed with a probe: a file holding one test that loops over three `subTest` cases, plus one plain
test.

| Run | `tests` | `failures` | `<testcase>` elements |
|---|---|---|---|
| all pass | 2 | 0 | 2 |
| the loop fails | 4 | 3 | 4 |

The python client runs `unittest` through `xmlrunner`. `unittest` reports every subtest to the
runner's result through `addSubTest(test, subtest, outcome)`, with `outcome` `None` for a pass.
`xmlrunner` writes a `<testcase>` only for a failing subtest and drops the passing ones. A test with
subtests is therefore one case when green and N cases when red.

The totals on the board move with the outcome, not with the suite, so RED and GREEN counts cannot
be compared: CR-CRU-184 cycle 665 reported 41 cases red and 7 green, and CR-CRU-186 cycle 672 21
red and 9 green. 53 of this repo's client test files use `subTest` (195 calls), and every
`unittest` project the client serves, Model B's included, is affected. The other stacks (bun, mvn,
rust, arduino) report each case as its own test case and are stable.

## Steps

### §S1 — a passing subtest is a test case

The python client's runner records each subtest as its own `<testcase>`, whether it passes or fails,
named as the failing one is named today (the parent test's name plus the subtest's parameters). A
test that has subtests is counted as its subtests, not as itself plus them.

So a suite's total is the same whether it passes or fails, and `passed + failed + pending = total`
holds on every run.

## Acceptance criteria

- [ ] **Totals match across outcomes.** Through the real python client against a live in-process
      board, the probe's file reports the same total when all pass and when the loop fails (4: three
      subtest cases plus the plain test), and the board stores that total both times.
- [ ] **Names match.** A subtest's case name is the same in the passing run and the failing run.
- [ ] **The sum holds.** For every run in those cases, `passed + failed + pending` equals `total`.
- [ ] **Unchanged where there are no subtests.** A file with no `subTest` reports exactly what it does
      today.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/` or in test comments, and
      the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: RED (the probe as a fixture), GREEN in the python client's runner, then verify.
The full python suite's reported total will rise once, by the passing subtests now counted.
