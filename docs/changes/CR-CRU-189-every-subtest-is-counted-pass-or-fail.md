# CR-CRU-189 — every subtest is counted, pass or fail

**Type** fix (patch CR) · **Points** 5 (filed at 3 on 2026-10-14; 5 at gap analysis, 2026-10-16) ·
**Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-14 (user ruling: a patch
CR, next after CR-CRU-188)

## Problem

Noticed by the user (2026-10-14): when every test passes, the total a python run reports is smaller
than the total the same tests report when some fail.

Confirmed with a probe: a file holding one test that loops over three `subTest` cases, plus one plain
test.

| Run | `tests` | `failures` | `<testcase>` elements |
|---|---|---|---|
| all pass | 2 | 0 | 2 |
| the loop fails | 4 | 3 | 4 |

The python client runs `unittest` through `xmlrunner` (`python -m xmlrunner …`). `unittest`
reports every subtest to the runner's result through `addSubTest(test, subtest, outcome)`, with
`outcome` `None` for a pass. unittest-xml-reporting 4.0.0's `addSubTest` writes a `<testcase>` only
for a failing subtest and drops the passing ones, and nothing on its command line changes that.
When every subtest passes, `unittest` also reports the parent test's own success, and that is the
one case written. A test with subtests is therefore one case when green and N cases when red.

The totals on the board move with the outcome, not with the suite, so RED and GREEN counts cannot
be compared: CR-CRU-184 cycle 665 reported 41 cases red and 7 green, and CR-CRU-186 cycle 672 21
red and 9 green. 57 of this repo's client test files call `subTest` (213 calls), and every
`unittest` project the client serves, Model B's included, is affected. The other stacks (bun, mvn,
rust, arduino) report each case as its own test case and are stable.

## Steps

### §S1 — the client runs xmlrunner through a runner of its own

A runner module ships with the clients, beside `toon.py`, and is one of the installer's packaged
fleet files. It runs `unittest` through xmlrunner's own program and report writer, with a result
class that extends xmlrunner's. The python client runs it with the project's interpreter in place
of `-m xmlrunner`, for both a targeted run and a discovery, with or without coverage. It keeps
xmlrunner's arguments, `-o <reports>` and `-v` among them. So every verb that runs the suite goes
through it: `test`, the tier verbs (`unit`, `module`, `integration`, `e2e`, `bdd`), `regression`
and `pre-merge-gate`.

A project whose interpreter has no xmlrunner gets the same cause as today, naming the missing
module.

### §S2 — a passing subtest is a test case, and its parent is counted as its subtests

The runner's result records each subtest as its own `<testcase>`, whether it passes or fails. A
passing subtest is named as a failing one is named today: the parent test's name plus the subtest's
parameters. A parent test whose subtests all pass is counted as its subtests, not as itself plus
them. A parent whose own body fails or errors outside its subtests is also a case of its own,
named as the parent, since that failure belongs to no subtest. A skip raised inside a subtest is a
pending case named as the subtest, as today. Nested subtests are counted as `unittest` reports
them: each `subTest` block is a case.

So a suite's total is the same whether it passes or fails, and `passed + failed + pending = total`
holds on every run.

### §S3 — an xmlrunner the runner cannot extend still runs, with a warning

When the project's xmlrunner does not have the result class the runner extends, the run goes
ahead on plain xmlrunner, as today. The run's envelope then carries a warning, `subtests-uncounted`,
naming the xmlrunner version found and saying that passing subtests were not counted. The run is
still filed and its exit is unchanged.

## Acceptance criteria

- [ ] **Totals match across outcomes.** Through the real python client against a live in-process
      board, a fixture file holding one test that loops over three `subTest` cases plus one plain
      test reports the same total when all pass and when the loop fails (4: three subtest cases
      plus the plain test), and the board stores that total both times. Checked for `test` and for
      `regression`, and for `regression` with coverage on.
- [ ] **Names match.** A subtest's case name is the same in the passing run and the failing run.
- [ ] **The sum holds.** For every run in those cases, `passed + failed + pending` equals `total`.
- [ ] **A parent's own failure is a case.** A test whose subtests pass and whose body then fails is
      filed as its passing subtests plus one failing case named as the parent.
- [ ] **Every verb runs it.** `test`, `unit`, `module`, `integration`, `e2e`, `bdd`, `regression`
      and `pre-merge-gate` each run the suite through the runner module, never `-m xmlrunner`,
      shown by each verb's spawned command line.
- [ ] **It ships.** The runner module is in the installer's packaged fleet, an install lays it down
      beside `toon.py`, and the installed python client runs a subtest fixture with the totals
      above.
- [ ] **No xmlrunner, same cause.** With no xmlrunner in the project's interpreter, `test` and
      `regression` answer as today, naming the missing module.
- [ ] **An xmlrunner it cannot extend.** With an xmlrunner lacking the result class, the run is
      filed with xmlrunner's own counts and its envelope carries the `subtests-uncounted` warning
      naming the version found.
- [ ] **Unchanged where there are no subtests.** A file with no `subTest` reports exactly what it does
      today.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/` or in test comments, and
      the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: RED (the probe as a fixture), GREEN in the runner module and the python
client, then verify. The test that pins the exact packaged fleet changes with §S1; that edit needs
approval and goes in its own commit. The full python suite's reported total will rise once, by the
passing subtests now counted. Model B hears of it in the 0.4.0 release notes.
