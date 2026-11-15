# CR-CRU-263 — CI runs the suites hermetically behind a tripwire

**Status:** PENDING · filed 2026-11-15 (release fix; user ruling 2026-11-15: the leak-census tripwire becomes a
standing guard, on this repo's CI now and as a client feature for every project in 0.5.0)
**Type:** fix
**Points:** 3
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-262
**Labels:** ci, tests, release
**Design reference:** `test-reports/work/rel040-test-gap-analysis.md` (§7); the census tools in
`test-reports/work/leak-census/` (`board-tripwire.py`, `run-dep-census.sh`); todo #28 (the 0.5.0 client feature)

## Problem

A leaky test passes wherever the thing it leaks to happens to exist: the operator's config, `~/.m2`, a board on the
operator port, the internet. CI had none of the first three and found nine leaks only after release; the eleven
tests that reached for port 3849 passed even there, because they tolerate a board that does not answer. Only the
census — a clean clone in an isolated network namespace with a listener on the operator ports — found them. Nothing
keeps that true after the release fix.

## Design

- **A hermetic run.** `test-python` and `test-bun` run their suites inside a new network namespace with only loopback
  up, as a plain (non-root) user, with `HOME` and the tool caches pointing at empty job-owned directories (the suite's
  own provisioned caches from CR-CRU-260 excepted) and no operator `crucible.toml`.
- **A tripwire.** Inside the namespace a listener on 127.0.0.1 and ::1 ports 3849 and 3850 logs every connection
  (time, port, process, first request line) and answers 503. Any logged connection fails the job after the suite, and
  the log is printed.
- **Versioned scripts.** The tripwire and the wrapper (namespace, loopback, dropped capabilities, run, verdict) move
  from `test-reports/work/leak-census/` into `scripts/hermetic/`, with tests of their own, so 0.5.0's client feature
  (todo #28) grows from them.
- **The runner's namespaces.** GitHub's `ubuntu-latest` (24.04) restricts unprivileged user namespaces through
  AppArmor. The job either lifts that restriction with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
  and runs `unshare --map-current-user --keep-caps -n` with capabilities dropped (`setpriv`) for the suite, or runs
  `sudo unshare -n` and drops back to the runner user. The gap analysis of this CR picks one and proves it on a CI run.
- **Network before the namespace.** Steps that need the internet (dependency installs, the suite's cache
  provisioning) run before the hermetic step, never inside it.
- **The local gate is unchanged** in 0.4.0 (user ruling: CI now, product later).

## Acceptance criteria

- [ ] **AC1 — the jobs are hermetic.** `test-python` and `test-bun` run their suites through `scripts/hermetic/`; a CI
  run log shows the namespace has no route but loopback and the suite runs as a non-root user.
- [ ] **AC2 — a hit fails the job.** A test of the wrapper with a probe that connects to 3849 in the namespace exits
  non-zero and prints the tripwire's line naming the process; with no connection it exits with the suite's own status.
- [ ] **AC3 — green.** A CI run on `release/0.4.0` passes `test-python` and `test-bun` hermetically with no tripwire
  line.
- [ ] **AC4 — pins.** The workflow and `ci-toolchain-provisioning` pin tests describe the hermetic steps.
- [ ] **AC5 — the workflow passes zizmor.** Every `uses:` in `.github/workflows/release.yml` is pinned to a full
  commit SHA, with its version in a trailing comment; no job that builds or publishes a release artefact restores a
  `setup-*` cache (zizmor `cache-poisoning`). A zizmor run over the workflow reports no `unpinned-uses` and no
  `cache-poisoning` finding. **Added 2026-11-15 (user ruling):** the 40 pre-existing findings (30 unpinned, 10
  cache-poisoning) found by pi-lens during CR-CRU-260; points re-scored at this CR's gap analysis.

## Non-goals

- The 0.5.0 client switch that offers hermetic runs to every project (todo #28).
- The e2e job (it runs a browser against its own server and `CRUCIBLE_DB`).
