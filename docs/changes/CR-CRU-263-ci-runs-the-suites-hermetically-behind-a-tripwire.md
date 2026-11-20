# CR-CRU-263 — CI runs the suites hermetically behind a tripwire

**Status:** PENDING · filed 2026-11-15 (release fix; user ruling 2026-11-15: the leak-census tripwire becomes a
standing guard, on this repo's CI now and as a client feature for every project in 0.5.0) · gap analysis 2026-11-20
(user rulings: the CI run is the proof — no tests of the hermetic scripts; `release/0.4.0` is pushed when this CR needs
its CI run) · spec pre-review 2026-11-20 (CHANGES, F1–F10 folded)
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
  them): the tripwire, the wrapper, the dependency hooks (the python audit hook with a versioned tagging runner, and the
  bun preload) and the verdict. No CR id in their lines. **No tests are written of these scripts** (user ruling
  2026-11-18/20: no tests that test the tests) — the CI run is the proof (AC1–AC3, AC6).
- **The runner** (pre-review F5): every job that runs the wrapper pins `runs-on: ubuntu-24.04` (`ubuntu-latest` is
  moving to 26.04). The job runs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`; the wrapper uses
  `unshare --map-current-user --keep-caps -n` and drops capabilities with `setpriv --ambient-caps -all --inh-caps -all
  --bounding-set -all --no-new-privs` — the local census's path. A missing `sysctl`, a refused `unshare`, a missing
  `ip`/`setpriv` is a SETUP failure with its own exit code and message, never mistaken for a verdict.
- **The wrapper prints what it set up** (F1), before the command: `ip -o addr` (only `lo`), `ip route` and
  `ip -6 route` (empty), `id`, and the `CapEff`/`CapBnd` lines of `/proc/self/status` as the command's own shell sees
  them.
- **The tripwire is robust** (F6): the wrapper waits for its listening banner and requires all four sockets
  (127.0.0.1 and ::1, ports 3849 and 3850); it logs at `accept()` (time, port, peer process when found, then the first
  request line); a tripwire that dies at any point fails the step; in-flight handlers are drained before the verdict.
  It starts with the hooks' environment stripped (F3c).
- **A hermetic run** (F4). `test-python` and `test-bun` run their tier steps through the wrapper. `HOME` points at an
  empty job-owned directory; the TOOLCHAINS stay where they were installed through an explicit allow-list the wrapper
  exports (`PLAYWRIGHT_BROWSERS_PATH`, `RUSTUP_HOME`, `CARGO_HOME`, arduino-cli's data directory, the go toolchain, and
  the suite's own provisioned caches from CR-CRU-260); everything else starts empty; no operator `crucible.toml`.
  `DOCKER_HOST` points at a socket that does not exist, so no test reaches the network through the docker daemon (F7).
  Steps that need the network (installs, cache provisioning, browser installs) run before the wrapper, never inside it.
  Before the push, the orchestrator runs one local census with the same redirection and allow-list (and `CI=true`),
  because CI allows one run at a time.
- **A deliberate trip** (F2), in place of a test of the wrapper, as a step inside `test-bun`: the wrapper over a probe
  that sends a request to 3849 and waits for the 503. The step passes only if the wrapper's exit code is the VERDICT's
  hit code (not a setup code), a `port=3849` line is present, and that line's `cmd=` carries the probe's marker.
- **The unit tiers stay unit (AC6)** (F3). The unit tier steps (`tests/unit`, `tests/client/unit`) run with the hooks
  recording; the VERDICT is taken over the event log after the run, never by raising inside a hook: any process start,
  socket connect, bind, serve or fetch, or wait above 0 ms fails the step and names the test file; the bun preload's
  own `loaded` line is excluded; an event charged to no file fails too and prints its top non-`node_modules` stack
  frame. The python unit step runs the versioned tagging runner (it sets the running test's id for the hook). Before the
  push, a per-file local run of `tests/unit` shows zero uncharged events.
- **The workflow passes zizmor (AC5)** (F8): `uvx zizmor@<pinned version> --offline .github/workflows/release.yml`
  is run by the orchestrator before the push and by a CI step. Every `uses:` is pinned to a full commit SHA with its
  version in a trailing comment (`pypa/gh-action-pypi-publish@release/v1` to its branch head, `# release/v1`); each
  cache-on-by-default action gets its cache-off input (`astral-sh/setup-uv` `enable-cache: false`,
  `oven-sh/setup-bun` `no-cache: true`, `actions/setup-node` `package-manager-cache: false`) wherever zizmor's output
  flags it, test jobs included.
- **Folded in** (routed here by CR-CRU-260's VERIFY): the redundant `python3 -m pip install --upgrade '.[dev]'` step in
  `test-python` goes if nothing in the job uses the runner's `python3` packages (else it stays, with its reason); all
  three e2e server starts pass `--no-env-file` (`spawnServer` in `tests/e2e/steps/backend-liveness.steps.ts`,
  `playwright.config.ts`'s `webServer.command`, `tests/e2e/teardown-contracts/ephemeral.playwright.config.ts`'s) (F10);
  `release.yml`'s long `bun-version` line is wrapped.
- **The local gate is unchanged** in 0.4.0 (user ruling: CI now, product later).
- **The push.** The CI run that proves this CR is on `release/0.4.0`, pushed when the work is ready (user ruling
  2026-11-20; `gh run list` checked first, one run at a time). The same run is the CI evidence for CR-CRU-259..264.

## Acceptance criteria

- [ ] **AC1 — the jobs are hermetic.** `test-python` and `test-bun` run their suites through `scripts/hermetic/`; the
  CI run log shows the wrapper's preamble: only `lo`, no route, `id`, and the dropped capability sets.
- [ ] **AC2 — a hit fails the job.** The deliberate-trip step passes in the CI run: the wrapper exits with the
  verdict's hit code and prints a `port=3849` tripwire line naming the probe.
- [ ] **AC3 — green.** A CI run on `release/0.4.0` passes `test-python` and `test-bun` hermetically with no tripwire
  line and all four tripwire sockets listening throughout.
- [ ] **AC4 — pins.** The existing pin tests are refactored to the hermetic steps (F9):
  `tests/unit/ci-toolchain-provisioning.test.ts` (`REQUIRED_PINS`/`ACTION_RUNTIMES` read the version from a SHA pin's
  trailing comment in the raw text); `tests/integration/pipeline-test-timeout-default.test.ts` (`bunTestPathArgs` skips
  the wrapper's and hooks' flags); the three python fixture guards (the new step strings);
  `tests/unit/ci-every-python-job-sets-up-the-python-floor.test.ts` (`runsPython` recognises `.venv/bin/python` and
  the wrapper).
- [ ] **AC5 — the workflow passes zizmor.** The pinned zizmor run reports no `unpinned-uses` and no `cache-poisoning`
  finding, before the push and in CI.
- [ ] **AC6 — the unit tiers stay unit.** In that CI run the unit tier steps run with the hooks and their verdict, and
  pass; the local per-file run before the push showed zero uncharged events.

## Non-goals

- The 0.5.0 client switch that offers hermetic runs to every project (todo #28); Model B's rendered workflows.
- The e2e job beyond its `--no-env-file` start (it runs a browser against its own server and `CRUCIBLE_DB`).
- Tests of the hermetic scripts (user ruling).
- Unix sockets other than docker's (a namespace does not cut filesystem sockets); `DOCKER_HOST` covers the one the
  suites use.
