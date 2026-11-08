# CR-CRU-237 — maven shows its surefire console live

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200, CR-CRU-201,
CR-CRU-225, CR-CRU-203 · **Status** PENDING — filed 2026-11-08, split from CR-CRU-203 at its
pre-review, with the user's rulings of 2026-11-08; made exact at gap analysis 2026-11-08 (user
rulings 2026-11-08) · Pre-review: ran — 8 points and user rulings (CR-CRU-203's pre-review,
findings F9–F15 and F17)

## Problem

A maven run shows nothing on its open run until maven exits.

- Surefire's console, while maven runs, states:
  - each class as it starts;
  - each class's counts as it ends;
  - each failed or errored test, by name, with its message.
- The client reads only the `Running <class>` lines, for a heartbeat narration (`running N/M
  classes`).
- Real surefire and failsafe 3.2.5 and 3.5.4 (`mvn -B`) print identical lines:

```text
[INFO] Running demo.BetaTest
[INFO] Running demo.BetaTest$Inner
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.004 s -- in demo.BetaTest$Inner
[INFO] Tests run: 0, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.535 s -- in demo.BetaTest
[INFO] Running demo.AlphaTest
[ERROR] Tests run: 4, Failures: 1, Errors: 1, Skipped: 1, Time elapsed: 1.514 s <<< FAILURE! -- in demo.AlphaTest
[ERROR] demo.AlphaTest.bad -- Time elapsed: 0.006 s <<< FAILURE!
org.opentest4j.AssertionFailedError: two is not three ==> expected: <2> but was: <3>
[ERROR] demo.AlphaTest.boom -- Time elapsed: 0.001 s <<< ERROR!
[ERROR] Tests run: 6, Failures: 1, Errors: 1, Skipped: 1
```

Real runs also show these cases:

| Case | Example |
| --- | --- |
| A class-level error with no method | `[ERROR] a.InitTest -- Time elapsed: 0.021 s <<< ERROR!` |
| A rerun reports a class twice | `rerunFailingTestsCount` |
| A test's own stdout reaches the console | `[INFO] Tests run: 9 … -- in fake.Spoof` printed by a test |
| `forkCount` and `-T` interleave `Running` lines | — |
| Parameterized names | `a.TwoTest.param(double)[2]` |
| A forked JVM that dies | prints no `-- in` line |

## Scope

- **§S1 — a declared verb's console reaches its open run.** A project declares a maven run's console
  view in the one `[targets.<key>]` vocabulary, keyed by the verb's tier. The client relays maven's
  combined console to the open run under a new `surefire-console` view codec, which the board reads.
  The record stays maven's JUnit reports (DN: console-only runners).
- **§S2 — the heartbeat steps back where the view replaces it.** A relayed run follows the fleet's
  rule (the shared `LandingPoster`, as bun, python, rust and arduino do):
  - no in-run `running N/M` tick while the relay lands, because its open run carries the live view
    and the agent's card follows it (CR-CRU-236);
  - the ticks resume if the board stops holding batches;
  - the closing `ran N/M classes` and `ingesting…` are always posted.

  An undeclared verb keeps today's heartbeat, with the same posts.

## Design (user rulings 2026-11-08)

### The declaration

The declaration lives in the project's own `crucible.toml`, one table per tier in the client's tier
vocabulary (`unit`, `module`, `integration`, `e2e`, `bdd`, `regression`). `test` reads the `unit`
entry.

```toml
[targets.regression]
framework = "surefire"
console = "surefire-console"
```

| Field | Allowed | Default |
| --- | --- | --- |
| `framework` | `surefire` | required |
| `console` | `surefire-console` | required |
| `junit`, `stream`, `coverage` | refused | — |

- **Undeclared:** a verb with no entry runs exactly as today, with no relay and the heartbeat.
- **Another stack's entry:** an entry whose `framework` belongs to another stack is skipped, not
  refused.
- **Refused before any board call, `docker-up` or maven:**
  - an entry under the run's own key with a wrong value or a refused key;
  - a file that does not parse;
  - a declared console on a board whose health lists no `surefire-console` view codec (bun's and
    rust's precedent, CR-CRU-225).
- **An unreadable health** refuses nothing and relays nothing. The run goes ahead unrelayed, with
  its heartbeat, as bun's does.

  The refusal names the table and the field. This holds for `e2e --with-docker` and
  `pre-merge-gate`, which check before `docker-up`.
- **Framework:** a declared run sends its `framework`, `surefire`.
- **Where the key is read:** `test` reads `unit`. `unit`, `module` and `bdd` read their own keys;
  `bdd` is reached through the declared-profile cell. `integration` and `e2e` read theirs, and
  `regression` and `pre-merge-gate`'s regression read `regression`. These are the four run bodies:
  the surefire tier, the failsafe tier, regression and test.

### The relay

- A tee writes maven's combined stdout and stderr to `<reports dir>/surefire-console.log` as it is
  read. The capture, `--log` and `raw` stay byte-identical. The tee moves from the bun client into
  the shared module, because both use it. The bun client keeps its own names as thin delegates, so
  no bun pin moves.
- The shared `StreamRelay` follows the file under the view codec.
- On every exit path, the relay finishes before the run is closed or aborted: 60 s, or 5 s when
  interrupted. The exit paths are:
  - the JUnit close;
  - the compile fallback;
  - ran-nothing;
  - abandon;
  - an exception from the run, where the relay finishes with 0 s and the exception is re-raised.

### The `surefire-console` view codec

The codec reads surefire's lines on the board, never as a record:

- **Line filter:** it reads only lines starting with `[INFO]`, `[ERROR]` or `[WARNING]` and a space, after
  stripping ANSI SGR.
- **Class counts:** a line ending `-- in <class>` sets that class's counts:
  - run;
  - failed = failures + errors;
  - pending = skipped;
  - passed = the rest.

  A later line for the same class replaces its counts; it does not add to them. A summary line with
  no `-- in` is read as nothing.
- **Failures:** a `<token> -- Time elapsed: … <<< FAILURE!` or `<<< ERROR!` line is one failure,
  de-duplicated by suite and name.
  - The class and method split at the last `.` before the first `(`.
  - A token that is the class itself is a class-level failure with name `""`, as JUnit stores it.
  - The message is the first non-blank following line that does not start with `[`; if there is
    none, there is no message.
- **Current file:** the last `Running` line not yet closed by its `-- in`.
- **Batches:** it resumes across batch boundaries and never re-reads a decoded byte.
- **View vs record:** the view can differ from the record (for example, a test printing
  surefire-like lines). The record wins.
- **Reader state:** the per-class counts and the open `Running` set are held compactly, as
  `class → [run, failed, pending]`, because the state is written on every batch.

## Acceptance criteria

- [ ] **AC1 — a declared verb's console reaches the open run.**
  - Covers `test`, every tier verb, and `pre-merge-gate`'s regression.
  - A declared run relays its console under `surefire-console` while maven runs.
  - Its open run's view shows each class's counts as the class ends, and each failure as its line
    arrives.
  - While the relay lands it posts no in-run tick. The closing count and `ingesting…` are posted,
    and the ticks resume when the board stops holding batches.
  - The relay runs in each of the four run bodies.
- [ ] **AC2 — the relay is finished before the close.**
  - On each exit path, an exception included, every relayed batch lands before the run is closed
    or aborted.
  - The capture, `--log` and `raw` are byte-identical to an unrelayed run.
- [ ] **AC3 — the codec reads surefire's lines as specified.** Every rule in "The `surefire-console`
  view codec" is proved on real captures from surefire and failsafe 3.2.5 and 3.5.4, kept as
  fixtures, covering:
  - a nested class;
  - a failure, an error and a skip;
  - a class-level error;
  - a rerun with a flake;
  - a parameterized failure;
  - a failsafe module;
  - a `forkCount=2` module;
  - a two-module `-T` reactor;
  - a forked JVM that dies.

  The codec is registered in `viewCodecs` only.
- [ ] **AC4 — maven's record is unchanged.** A relayed run stores the same counts, failures and
  coverage that the same run's JUnit stored before this CR, plus the framework `surefire`.
- [ ] **AC5 — undeclared runs are unchanged.** An undeclared verb relays nothing and keeps its
  heartbeat, with the same posts and envelope as before this CR.
- [ ] **AC6 — the declaration is read and refused as specified.** Every refusal in "The declaration"
  is covered, each before any board call, `docker-up` or maven, including `e2e --with-docker` and
  `pre-merge-gate`.
- [ ] **AC7 — every caller is kept green.**
  - Every test in both suites (bun `tests/*.ts` and `tests/client/*.py`) that drives
    `mvn-crucible.py` passes: 69 files at this CR's gap analysis (59 python, 10 bun).
  - Adding the codec changes health's `codecs.view`. The four bun tests that pin it as
    `["bun-console"]` are re-pinned in the codec's own cycle:
    - `tests/gate-milestone-scope-and-suites.test.ts`;
    - `tests/health-lists-the-record-stream-codecs.test.ts`;
    - `tests/health-names-the-codecs-it-decodes.test.ts`;
    - `tests/view-codecs-live-in-their-own-registry.test.ts`.
  - The same holds for the tests of the shared module and of any client whose code moves.
  - A call sequence is re-pinned only where this CR changes what a run posts.
  - No narration test is rewritten: no existing test pins a relayed maven run, and undeclared runs
    keep their heartbeat.
  - Any change in the size of `_crucible_run.py` or `_crucible_axi.py` re-records
    `SHARED_MODULE_LINE_BUDGETS` in all three files that pin it, in the same change.
- [ ] **AC8 — the docs follow.** The CHANGELOG's `[Unreleased]` names the declaration and the
  `surefire-console` codec, under "Stack declaration changes" for the release notes to Model B.
  `clients/crucible.toml`'s commented reference names the maven entry. `mvn-crucible.py --help`
  names the declaration. The DN's console-only row names `surefire-console` for maven.

## Non-goals

- A JUnit Platform listener for maven, which would be a structured maven stream.
- A total in advance: maven states none.
- Namespacing `[targets.<key>]`. Rust keys its entries by nextest profile (`default`, `ci`, `e2e`),
  so a project with both stacks cannot declare a rust `e2e` and a maven `e2e`. Each client skips
  the other's framework, so reading stays safe.
