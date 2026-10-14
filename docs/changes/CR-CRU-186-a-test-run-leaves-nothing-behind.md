# CR-CRU-186 — a test run leaves nothing behind

**Type** fix (patch CR) · **Points** 5 (confirmed at gap analysis, 2026-10-14) · **Wave** 8 (0.4.0) ·
**Depends on** CR-CRU-184 · **Status** PENDING — filed 2026-10-14 (user ruling: a patch CR placed
next in wave 8, after the setup/teardown leak review)

## Problem

Found by the setup/teardown leak review the user asked for after CR-CRU-185 (2026-10-14), and by
CR-CRU-181's VERIFY (2026-10-13).

Measured on one clean full run of both suites through the client (python 2456/0, bun 3357/0), with
`/tmp`, the process list, the listening ports and a copy of the dev board's store snapshotted before
and after:
- the dev board received only the run's own two ingests, and no suite wrote to it;
- no process or port was left behind;
- **the bun suite left 87 directories in `/tmp`**, and the python suite left none.

| Leaking source | Dirs per run |
|---|---|
| `tests/queue-registration.test.ts` (`cru014-queue-*`) | 37 |
| `playwright.config.ts` (`crucible-e2e-*`, one per Playwright run) | 13 |
| `tests/db-path-resolution.test.ts` (`crucible-dbpath-test-*`) | 13 |
| `tests/releases.test.ts` (`cru074-releases-*`) | 11 |
| `tests/checkpoint-stop.test.ts` | 3 |
| `tests/cycle-epochs.test.ts`, `tests/roadmap-visual-grammar.test.ts`, `tests/boot-safety.test.ts` | 2 each |
| `tests/plan-abort.test.ts`, `tests/e2e-suite-reaches-the-board.test.ts`, the `crucible-e2e-f10-*` scenario, one bare `tmp.*` | 1 each |

Static reading finds the same files creating temp dirs with no removal, plus
`tests/e2e/steps/backend-liveness.steps.ts`, `tests/e2e/teardown-contracts/ephemeral.playwright.config.ts`
and `tests/client/live_run_harness.py`. Two days of runs had left over a thousand such directories.

Two client defects belong to the same class:

1. **An interrupted runner leaves its descendants running.** The shared runner (`run_streamed`)
   starts the test runner in the client's own process group and kills only that direct child. A
   runner that spawns its own children keeps them alive. For example, `bun run test:e2e` starts
   Playwright, which starts its test server on :39877. During CR-CRU-181's VERIFY such a server was
   orphaned (re-parented to the session manager) and held :39877, and every later e2e drive failed.
2. **An e2e run that never ran reports success.** With :39877 taken, `bunx playwright test` exited 1
   before running a test. `bun-crucible.py e2e` still reported `ok: true`, `total: 0`, exit 0, and
   filed an empty run.

## Steps

### §S1 — every test cleans up what it creates

Each leaking file above removes the directories it creates (`afterEach`/`afterAll`, or
`addCleanup` in python), on success and on failure. `playwright.config.ts` removes the run's
database directory when the run ends (global teardown).

### §S2 — a run-scoped temp root catches the rest

The bun test preload (`tests/helpers/isolated-store-preload.ts`, wired in `bunfig.toml`) creates one
directory per test run, points `TMPDIR` at it before any suite loads, and removes it when the run
exits. The per-run directory lives under the system temp root, so a path a test checks against
that root still matches. It covers the test process's own temp paths and every child spawned with
the environment passed explicitly.

Bun (1.4.2) hands a child spawned WITHOUT an explicit `env` the environment as it stood when the
process started, so a `TMPDIR` set in the preload never reaches it. That reach comes from the
client instead (user ruling, 2026-10-14): `bun-crucible.py` exports a run-scoped `TMPDIR` (one
directory per run, under the system temp root) for every runner it spawns for a test-family verb
(`test`, `regression`, `pre-merge-gate`, declared scripts including `e2e`), and removes it when the
runner exits, on every exit path. Every child of a client-driven run then inherits it. A bare
`bun test` run by hand relies on each file's own cleanup (§S1).

The python client suite left nothing in either measured run, so it gets no backstop. A test that
writes to a hard-coded `/tmp` path bypasses `TMPDIR`; the guard in the acceptance criteria catches it.

### §S3 — an interrupted runner takes its whole tree down

`run_streamed` starts the runner in a new session (its own process group), in BOTH of its branches:
the teed one (`Popen`) and the inherited-stdio one (`subprocess.run`, used when there is no log, no
narrator and no capture). On an interrupt (the abandon trap from CR-CRU-184, or a `KeyboardInterrupt`
when no trap is installed) or any exception while the runner is live, it signals the whole group
(SIGTERM, then SIGKILL after a short grace) and reaps it. A runner that exits on its own is
unaffected.

A runner in its own session no longer receives a terminal's Ctrl-C directly. The client, which does
receive it, takes the group down, so a Ctrl-C still stops the whole tree with or without `--agent`.
A client killed by SIGKILL cannot clean up; that is a non-goal. The compile, check and docker helpers that call `subprocess.run` directly are not
interrupted runs, and are a non-goal.

The teed branch of `run_streamed` waits for the runner inside the same guard that takes the group
down, so a signal that lands after the runner's output ends but before it is reaped still takes the
group down.

### §S4 — a runner that ran nothing is a failure

A runner that exits without writing a report is already handled: the verb aborts its run and reports
`no_report_warning` with the runner's exit code and output tail. That exit is unchanged, including
bun `test`'s deliberate exception, which files a synthetic compile failure instead.

The gap is a report that EXISTS but holds zero results while the runner exited non-zero, which is
what Playwright writes when it cannot start. That case now takes the same no-report exit: `ok: false`,
non-zero, the `no_report_warning` naming the runner's exit code and output tail, and the run aborted
(`no_report_left_open_warnings` when the abort is refused), never filed as `total: 0`. A runner that
exits 0 with zero results keeps today's behaviour.

## Acceptance criteria

- [ ] **A full run leaves `/tmp` as it found it.** A guard test runs representative suites (each
      file in the table above) as a child `bun test` with the normal preload, and asserts the system
      temp root holds no new entry afterwards. The same check, measured by the orchestrator on a full
      bun run and a full python client run through the client, finds zero new entries.
- [ ] **Each named file cleans up.** For EACH file in the table, plus `backend-liveness.steps.ts`,
      `ephemeral.playwright.config.ts` and `live_run_harness.py`, the directories it creates are
      gone after it runs, on a passing and on a failing run. That holds with the run-scoped temp root
      disabled, so the backstop is not what passes it.
- [ ] **The temp root is run-scoped.** Under the preload, `os.tmpdir()` (bun) and
      `tempfile.gettempdir()` (in a python child spawned with the environment passed) resolve inside
      one per-run directory, and
      that directory is removed when the run exits, including when a test fails.
- [ ] **The client scopes the run's temp root.** For EACH test-family verb of `bun-crucible.py`
      (`test`, `regression`, a declared script), the spawned runner sees `TMPDIR` set to one
      directory under the system temp root, a child it spawns WITHOUT an explicit env sees the same
      value, and the directory is gone after the client exits: on a pass, a failure, a runner with
      no report, and SIGTERM.
- [ ] **The runner's tree is killed.** For EACH of the five clients' `test` verb, with a fake runner
      that starts a long-lived grandchild, SIGTERM to the client during the runner leaves no
      descendant process alive after the client exits (checked by pid), and the exit is 143. A
      runner that exits on its own leaves its normal exit unchanged.
- [ ] **Both branches, and Ctrl-C without an agent.** The same grandchild check holds for
      `run_streamed`'s inherited-stdio branch, and for SIGINT delivered to a client run WITHOUT
      `--agent` (no trap installed).
- [ ] **An e2e that never ran fails.** `bun-crucible.py e2e` against a project whose Playwright
      exits 1 before running anything (e.g. its port is taken) exits non-zero with `ok: false`, the
      `no_report_warning` naming the runner's exit code, and the run aborted, never filed as
      `total: 0`. The same holds for `test` in EACH of the five clients with a fake runner that
      exits non-zero and writes a report holding zero results.
- [ ] **Every report-ingesting verb.** The same holds for each other test-family verb that ingests a
      report: bun `regression` on its JUnit route (and so `pre-merge-gate`'s whole-suite step and
      a declared script on that route), python `regression`, rust `workspace-regression` and
      `smoke-test`, mvn's surefire tiers (`unit`, `module`), its failsafe tiers (`integration`,
      `e2e`) and `regression`. One case per verb, each through the real client.
- [ ] **Existing exits unchanged.** Every existing no-report and abort test passes unchanged,
      including bun `test`'s synthetic compile failure for a missing JUnit report, and a runner
      that exits 0 with zero results.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/`, `src/` or `tests/`
      comments, and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: one cycle each for §S1+§S2 (the temp root), §S3 (the process tree) and §S4
(the empty run), RED first, then verify.
