# CR-CRU-155 — each test run keeps its reports to itself

**Type** fix · **Wave** 7 (0.3.0), after CR-CRU-149 (user ruling 2026-09-27) · **Depends on** — ·
**Status** PENDING — filed 2026-09-27 (user's special permission to file mid-run)

## Problem

**Measured 2026-09-27, in CR-CRU-149's cycle 539.** Five GREEN agents ran at the same time in one
working tree, each on its own files, each running tests through the client. The client writes the
run's JUnit results to one fixed place in the project and reads that file back to ingest it. One
agent's run overwrote the file before another's client read it: `CR-CRU-149-539-GREEN-2` filed 33
passed / 2 failed, another run's result, where its own run was 292 / 0. The wrong record stays on
the board under its name.

Every client shares one report location per project:

- **bun:** `test-reports/junit.xml` (`DEFAULT_REPORTS`), and coverage in the project's `coverage/`.
- **python:** `test-reports/`, which it WIPES before every run (`_wipe`), so a second concurrent
  run can delete the first run's results before they are ingested, not merely overwrite them.
- **arduino:** `tests/native/reports`.
- **rust / mvn:** the tool's own output under `target/` (nextest, surefire); `mvn clean` removes it.

Agents' working trees do not isolate this: `test-reports/` and `coverage/` are per project, and a
worktree is not always in use. A brief that says "use a private `--reports`" works only when every
brief says it, for every agent, in every project; the client knows the run and the agent and can do
it itself.

**User ruling 2026-09-27:** the client handles it; no orchestrator or agent rule is needed for the
reports location.

## Scope (provisional — settled at gap analysis)

### §S1 — a run's reports are its own

When `--reports` is not given, each run writes its results (and its coverage, where the stack
produces it) into a directory no other run uses, reads them back from there, and ingests them.
Only that directory is ever cleared. Two runs of the same project at the same time, by the same or
different agents, never read or clear each other's results.

### §S2 — explicit locations keep working

An explicit `--reports <dir>` behaves as today, and so does `auto-ingest` of a directory a caller
produced. Whatever reads the default location today (e.g. the pre-merge gate reading coverage) reads
the run's own directory instead.

### §S3 — all five clients

The behaviour lives once in the shared client module and is used by `bun-crucible.py`,
`python-crucible.py`, `rust-crucible.py`, `mvn-crucible.py` and `arduino-crucible.py`.

## Design questions for the gap analysis (to the user)

1. **Where** the per-run directory lives: under the project (`test-reports/<agent>/<run>/`,
   gitignored) or a system temp directory; and whether it is removed after ingest or kept (the last
   N) for an agent to read.
2. **rust and mvn** write where their tool decides (`target/nextest/…`, `target/surefire-reports`):
   can each be redirected per run (nextest's JUnit path, surefire's `reportsDirectory`), and what
   `mvn clean` does to a concurrent run's output.
3. **Coverage** (bun `coverage/`, python `.coverage`, rust llvm-cov, JaCoCo): per run too, or only
   the JUnit results.

## Acceptance criteria

Written at gap analysis, once the questions above are ruled.
