# CR-CRU-208 — a runner that failed is never filed as green

**Type** fix · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(user ruling: an urgent fix CR, sequenced straight after CR-CRU-207)

## Problem

**Measured 2026-10-27/28.** A bun test file that fails to load, or throws while it is imported, is
counted by bun itself — a scratch run of three files (one passing, one importing a missing module, one
throwing at import) prints `1 pass · 2 fail · 2 errors · Ran 3 tests across 3 files` under
`# Unhandled error between tests`, and exits 1 — but bun's JUnit report holds only the passing case
(`failures="0"`). The bun client builds its run from that report, so the stored run reads 1 passed,
0 failed, and with `--agent` its `test` verb returns 0 whenever the report shows no failure and the
ingest succeeded, ignoring the runner's exit code. A pre-merge gate composes those exits and counts,
so **a gate passes while test files never ran**.

It happened on this branch's history: CR-CRU-207's C2 left an import cycle that stopped 13 test files
loading; bun printed `13 fail · 13 errors`, the client ingested `87 passed, 0 failed` across 4 files.
VERIFY caught it by reading bun's log. No merged gate was affected (CR-CRU-153, 205, 152 and 207's gate
logs each show bun's own summary matching the ingest, no load error).

The same shape — the runner exits non-zero while its report shows no failure — is decided from the
report alone in every client, so no client may treat it as green either.

## Design (user rulings, 2026-10-28)

- **Bun's load errors are failures, one case per file.** Each test file bun reports under
  `# Unhandled error between tests` becomes a failing case in the run the client files: suite = the
  file's path as bun prints it, case `?` (failed to load), message = bun's `error:` line, trace = the
  block. The stored counts then match bun's own `fail` count.
- **A fleet-wide rule in the shared module:** a runner that exits non-zero while the report it wrote
  holds results and no failure is never filed or returned as green, in all five clients. The run is
  filed with one failing case naming the runner's exit code, and the verb exits non-zero with a
  warning, so the gate cannot pass on it.

## Steps

### §S1 — bun's console names the files that failed to load

The bun client reads its captured console for each `<path>:` header followed by
`# Unhandled error between tests` and its `error:` block (both wire forms, as the console is read
today), and adds one failing case per such file to the tree it files, before it decides its exit
code.

### §S2 — one shared rule for a runner that failed without saying so

`_crucible_axi.py` gains `runner_failed_unreported(exit_code, summary)` — true when the runner exited
non-zero, the report holds results, and none of them failed — and `unreported_failure_case(exit_code)`,
the failing case it adds (suite `runner`, case `exit <code>`, message
`the runner exited <code> but its report records no failure`). Every verb that ingests a test run, in
each of the five clients, applies it after reading the report and before deciding its exit: the case
is added to the filed tree, the envelope carries a `runner-failed-unreported` warning naming the exit
code, and the verb exits non-zero. A runner that exits 0, or whose report already records a failure,
is unchanged; `ran_nothing` (a non-zero exit with zero results) keeps its own path.

### §S3 — the exit code follows the filed run

After §S1 and §S2, each verb's exit is non-zero whenever the run it filed has a failure — the bun
`test` verb's `return 0 if ingest ok and no failure` reads the filed tree, not the report alone.

## Acceptance criteria

- [ ] **AC1 — bun's load errors are filed.** A real bun run (a scratch project with a passing file, a
      file importing a missing module and a file throwing at import, in both console wire forms) run
      through `bun-crucible.py test --agent` files 1 passed and 2 failed, each failing case named by
      its file with bun's error as its message, and the verb exits non-zero.
- [ ] **AC2 — the shared rule.** `runner_failed_unreported` is true exactly for (non-zero exit,
      results, no failure) and false for exit 0, for a report with a failure, and for zero results
      (`ran_nothing`'s shape); `unreported_failure_case` builds the stated case.
- [ ] **AC3 — every verb, every client.** A census test enumerates each verb that ingests a test run
      in each of the five clients and asserts each calls `runner_failed_unreported`; for one verb per
      client, a fake runner that exits 1 with a passing-only report is filed with the `exit 1` case,
      carries the `runner-failed-unreported` warning, and the verb exits non-zero.
- [ ] **AC4 — the gate.** `pre-merge-gate` over a suite whose runner exits non-zero with a
      passing-only report is not green: it reports that suite failed.
- [ ] **AC5 — nothing else changes.** A run whose runner exits 0, or whose report records a
      failure, is filed and exits exactly as before (the existing client suites pass unchanged).

## Non-goals

- The board decoding these from raw output: CR-CRU-204 and CR-CRU-206 carry both rules when the
  clients stop parsing (their gap analyses take this CR's cases).
- Other runners' load-error shapes beyond the shared exit rule.
