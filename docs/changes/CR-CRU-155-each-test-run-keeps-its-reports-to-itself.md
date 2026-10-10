# CR-CRU-155 — each test run keeps its reports to itself

**Type** fix · **Points** 8 · **Wave** 7 (0.3.0), after CR-CRU-149 (user ruling 2026-09-27) ·
**Depends on** — · **Status** PENDING — filed 2026-09-27 (user's special permission to file mid-run)

## Problem

**Measured 2026-09-27, in CR-CRU-149's cycle 539.** Five GREEN agents ran at the same time in one
working tree, each on its own files, each running tests through the client. The client writes the
run's JUnit results to one fixed place in the project and reads that file back to ingest it. One
agent's run overwrote the file before another's client read it: `CR-CRU-149-539-GREEN-2` filed 33
passed / 2 failed, another run's result, where its own run was 292 / 0. The wrong record stays on
the board under its name.

Every client shares one report location per project (measured 2026-09-27 at `fc4a40c`):

- **bun:** `test-reports/junit.xml` (`DEFAULT_REPORTS`, `DEFAULT_JUNIT`), the raw report a declared
  target writes for the server to decode (e.g. `playwright.json`) in the same directory, and
  coverage in the project's `coverage/`. `_wipe` removes this run's own files first.
- **python:** `test-reports/`, which `_wipe` EMPTIES before every run, so a second concurrent run can
  delete the first run's results before they are ingested, not merely overwrite them; coverage.py's
  data file sits in the working directory.
- **arduino:** the client runs `make <target>` in the native directory and reads what the project's
  Makefile wrote: `reports/TEST-*.xml` and `coverage/lcov.info` there.
- **rust:** nextest writes JUnit to `target/nextest/<profile>/junit.xml`, a path its profile config
  fixes; llvm-cov writes its coverage under `target/`.
- **mvn:** surefire and failsafe write under `target/`, JaCoCo its CSV under `target/`, and
  `mvn clean` deletes `target/`.

**User rulings 2026-09-27:** the client handles it (no orchestrator or agent rule for the reports
location); isolation is per AGENT, and the directory is kept after the run; all five clients;
coverage moves too.

## Scope

### §S1 — an agent's run reports into the agent's own directory

A run made with `--agent <id>` and no `--reports` writes, reads and ingests its results under
`test-reports/<id>/` in the project (gitignored with the rest of `test-reports/`): the JUnit results,
any raw report the run produces for the server, and its coverage. Only that directory is cleared
before the agent's next run, and it is kept afterwards so the agent can read it. Two agents never
share, read or clear each other's directory. (One agent never runs two suites at once; that is the
agent's discipline, not this CR's.)

### §S2 — what stays as it is

- A run without `--agent` uses today's locations.
- An explicit `--reports <dir>` is used as given.
- `auto-ingest` of a directory a caller produced reads that directory.
- Whatever reads a run's reports or coverage afterwards (the pre-merge gate's coverage, a raw report
  sent to the server) reads them from the directory the run actually used.

### §S3 — all five clients, per stack

The rule is implemented once in the shared client module, used by all five clients. Each stack gets
its outputs into the agent's directory the way its tool allows:

- **bun, python:** the client chooses the paths, so it writes them there directly (bun: the JUnit
  and raw-report paths and `--coverage-dir`; python: the xmlrunner output directory and coverage.py's
  data file).
- **mvn:** the client passes the locations to Maven (`-Dsurefire.reportsDirectory`,
  `-Dfailsafe.reportsDirectory`, and JaCoCo's output where the plugin accepts it). A POM that pins
  `reportsDirectory` in its plugin configuration overrides that property, so, as for arduino, when
  the agent's directory holds no results after the run but `target/surefire-reports` or
  `target/failsafe-reports` do, the client moves them in and warns (user ruling 2026-09-27).
- **arduino:** the client passes the locations to `make` (`REPORTS_DIR=`, `COVERAGE_DIR=`), a
  documented contract for the project's Makefile. A Makefile that ignores them still works: the
  client moves what it wrote into the agent's directory right after the run and says so in a
  warning.
- **rust:** nextest's JUnit path and llvm-cov's output are fixed by the tool, so the client moves them
  into the agent's directory right after the run, before reading them. The window between the tool
  writing and the client moving is narrowed, not closed; the client's help text and this spec say so.

## Acceptance criteria

- [x] **AC1 (§S1)** — In EACH of the five clients, a run with `--agent A` and no `--reports` ingests the
  results from `test-reports/A/` (for the stack's tool-written outputs, after moving them there), and
  a run by agent B in the same project, at the same time, neither reads nor clears A's directory.
- [x] **AC2 (§S1)** — The python client no longer empties the shared `test-reports/`: an agent's run
  clears only its own `test-reports/<agent>/`, and a file placed in another agent's directory survives
  it.
- [x] **AC3 (§S1)** — An agent's directory is still there after its run, holding that run's results.
- [x] **AC4 (§S2)** — A run without `--agent` uses today's locations; `--reports <dir>` is used as given;
  `auto-ingest` of a given directory is unchanged.
- [x] **AC5 (§S2)** — Coverage follows the run: `regression --coverage` and the pre-merge gate (bun) read
  the coverage the run wrote in the agent's directory, and ingest the same line and function figures
  as today on the same tree.
- [x] **AC6 (§S2)** — A declared raw report (bun's `test:e2e` `playwright.json`) is written to and sent
  from the agent's directory.
- [x] **AC7 (§S3)** — mvn passes the agent's directory to surefire and failsafe, and when a POM's own
  `reportsDirectory` overrides it, moves the results into the agent's directory and warns; arduino passes
  `REPORTS_DIR`/`COVERAGE_DIR` to `make` and, when the Makefile ignores them, moves the output and
  warns; rust moves nextest's JUnit and llvm-cov's output before reading them. Each is asserted on
  the command the client builds and on where the ingested files came from.
- [x] **AC8 (wiring)** — End to end, two agents running the bun client against one real ephemeral board
  at the same time, in one project, each file their OWN results (distinct counts).
- [x] **AC9** — The clients' `--reports` help text states the per-agent default, and rust's states the
  narrowed-not-closed window.

## Non-goals

- **Two suites by one agent at the same time.** Per-agent isolation assumes one agent runs one suite
  at a time.
- **Cleaning up old agent directories.** They are kept; `test-reports/` stays gitignored.
- **Changing what a stack's tool writes by default.** Only where the client reads from.
