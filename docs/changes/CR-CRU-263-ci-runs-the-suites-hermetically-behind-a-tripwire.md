# CR-CRU-263 — CI runs the suites hermetically behind a tripwire

**Status:** PENDING · filed 2026-11-15 (release fix; user ruling 2026-11-15: the leak-census tripwire becomes a
standing guard, on this repo's CI now and as a client feature for every project in 0.5.0) · gap analysis 2026-11-20
(user rulings: the CI run is the proof — no tests of the hermetic scripts; `release/0.4.0` is pushed when this CR needs
its CI run)
**Type:** fix
**Points:** 8 (re-scored from 3 at the gap analysis: AC5 and AC6 joined)
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-262, CR-CRU-264
**Labels:** ci, tests, release
**Design reference:** `test-reports/work/cr263-gap-analysis.md`; `test-reports/work/rel040-test-gap-analysis.md` (§7);
the census tools in `test-reports/work/leak-census/` (`board-tripwire.py`, `run-dep-census-*.sh`,
`audit/sitecustomize.py`, `bun-dep-preload.ts`); todo #28 (the 0.5.0 client feature); Model B request #1619 and its
reply #1621 (this CR is Crucible's own CI only)

## Problem

A leaky test passes wherever the thing it leaks to happens to exist: the operator's config, `~/.m2`, a board on the
operator port, the internet. CI had none of the first three and found nine leaks only after release; the eleven
tests that reached for port 3849 passed even there, because they tolerate a board that does not answer. Only the
census — a clean clone in an isolated network namespace with a listener on the operator ports — found them, and it
has run only on the orchestrator's machine. Nothing keeps that true after the release fix: the census tools are
git-ignored scratch, and CR-CRU-261 retired the only guard that pinned tier membership.

## Design

- **Versioned scripts** in `scripts/hermetic/` (moved from the census tools, so 0.5.0's client feature grows from
  them): the tripwire (listener on 127.0.0.1 and ::1, ports 3849 and 3850, logs time, port, peer process and first
  request line, answers 503); the wrapper (namespace with loopback only, capabilities dropped with `setpriv`, run the
  given command as a plain user, then the verdict: any tripwire line fails the step and is printed, otherwise the
  command's own exit status); the dependency hooks (the python audit hook and the bun preload) in a FAILING mode for the
  unit tiers. No CR id in their lines. **No tests are written of these scripts** (user ruling 2026-11-18/20: no tests
  that test the tests) — the CI run is the proof (AC1–AC3, AC6).
- **The runner's namespace** (ubuntu-24.04 restricts unprivileged user namespaces through AppArmor): the job runs
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, then the wrapper uses
  `unshare --map-current-user --keep-caps -n` with capabilities dropped — the same path as the local census.
- **A hermetic run.** `test-python` and `test-bun` run their tier steps through the wrapper: `HOME` and the tool caches
  point at empty job-owned directories (the suite's own provisioned caches from CR-CRU-260 excepted), no operator
  `crucible.toml`. Steps that need the network (dependency installs, the suite's cache provisioning, browser installs)
  run before the wrapper, never inside it.
- **A deliberate trip** (the proof that a hit fails the job, in place of a test of the wrapper): one CI step runs the
  wrapper over a one-line probe that connects to 3849 and expects the wrapper to exit non-zero with the tripwire's
  line; the step fails if the wrapper does not.
- **The unit tiers stay unit (AC6).** The unit tier steps (`tests/unit`, `tests/client/unit`) run with the hooks in
  failing mode: any process start, socket connect, bind, serve or fetch, or wait above 0 ms fails the job and names
  the test file (an event charged to no file fails it too, naming the step).
- **The workflow passes zizmor (AC5)**: every `uses:` pinned to a full commit SHA with its version in a trailing
  comment; no job that builds or publishes a release artefact restores a `setup-*` cache.
- **Folded in** (routed here by CR-CRU-260's VERIFY): the redundant `python3 -m pip install --upgrade '.[dev]'` step in
  `test-python` goes if nothing in the job uses the runner's `python3` packages (else it stays, with its reason); the
  e2e backend-liveness start passes `--no-env-file`; `release.yml`'s long `bun-version` line is wrapped.
- **The local gate is unchanged** in 0.4.0 (user ruling: CI now, product later).
- **The push.** The CI run that proves this CR is on `release/0.4.0`, pushed when the work is ready (user ruling
  2026-11-20; `gh run list` checked first, one run at a time). The same run is the CI evidence for CR-CRU-259..264.

## Acceptance criteria

- [ ] **AC1 — the jobs are hermetic.** `test-python` and `test-bun` run their suites through `scripts/hermetic/`; the
  CI run log shows the namespace has no route but loopback and the suite runs as a non-root user.
- [ ] **AC2 — a hit fails the job.** The deliberate-trip step: the wrapper over a probe that connects to 3849 exits
  non-zero and prints the tripwire's line naming the probe; the CI run log shows it.
- [ ] **AC3 — green.** A CI run on `release/0.4.0` passes `test-python` and `test-bun` hermetically with no tripwire
  line.
- [ ] **AC4 — pins.** The workflow and `ci-toolchain-provisioning` pin tests (existing tests, refactored) describe the
  hermetic steps.
- [ ] **AC5 — the workflow passes zizmor.** A zizmor run over `.github/workflows/release.yml` reports no
  `unpinned-uses` and no `cache-poisoning` finding.
- [ ] **AC6 — the unit tiers stay unit.** In that CI run the unit tier steps run with the hooks in failing mode and pass.

## Non-goals

- The 0.5.0 client switch that offers hermetic runs to every project (todo #28); Model B's rendered workflows.
- The e2e job beyond its `--no-env-file` start (it runs a browser against its own server and `CRUCIBLE_DB`).
- Tests of the hermetic scripts (user ruling).
