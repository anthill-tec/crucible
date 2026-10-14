# CR-CRU-186 — a test run leaves nothing behind

**Type** fix (patch CR) · **Points** 5 (set at filing, 2026-10-14) · **Wave** 8 (0.4.0) ·
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
exits. Child processes (spawned clients, Playwright and its test server) inherit `TMPDIR`. The
python client suite gets the same through its runner entry point. A test that forgets its cleanup
then leaves nothing in the system temp root.

### §S3 — an interrupted runner takes its whole tree down

`run_streamed` starts the runner in a new session (its own process group). On an interrupt (the
abandon trap from CR-CRU-184) or any exception while the runner is live, it signals the whole group
(SIGTERM, then SIGKILL after a short grace) and reaps it. A runner that exits on its own is
unaffected. The compile, check and docker helpers that call `subprocess.run` directly are not
interrupted runs, and are a non-goal.

### §S4 — a runner that ran nothing is a failure

When a test-family verb's runner exits non-zero and its report holds zero results (no report, or a
report with `total: 0`), the verb exits non-zero with `ok: false`. The envelope names the runner's
exit code and the tail of its output. The run is aborted, not filed as an empty pass. A runner that
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
      `tempfile.gettempdir()` (in a spawned python client) resolve inside one per-run directory, and
      that directory is removed when the run exits, including when a test fails.
- [ ] **The runner's tree is killed.** For EACH of the five clients' `test` verb, with a fake runner
      that starts a long-lived grandchild, SIGTERM to the client during the runner leaves no
      descendant process alive after the client exits (checked by pid), and the exit is 143. A
      runner that exits on its own leaves its normal exit unchanged.
- [ ] **An e2e that never ran fails.** `bun-crucible.py e2e` against a project whose Playwright
      exits 1 before running anything (e.g. its port is taken) exits non-zero with `ok: false`, an
      envelope naming the runner's exit code, and the run aborted, never filed as `total: 0`. The
      same holds for `test` in EACH of the five clients with a fake runner that exits non-zero and
      writes no results.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/`, `src/` or `tests/`
      comments, and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: one cycle each for §S1+§S2 (the temp root), §S3 (the process tree) and §S4
(the empty run), RED first, then verify.
