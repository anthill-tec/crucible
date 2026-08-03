# CR-CRU-062 — CI publishes but never tests: no workflow runs the suite

**Status:** PENDING
**Type:** feature (CI verification)
**Priority:** P1 — not a release blocker for 0.1.0, but it is the reason a bad tag could publish
**Depends on:** CR-CRU-041 (release.yml), CR-CRU-052 (e2e DB isolation), CR-CRU-060 (e2e suite green)
**Labels:** feature, ci, github-actions, gates, test-infrastructure
**Phase:** Wave 4
**Design reference:** `docs/research/DN-release-process.md` §3 Step 4

## Context

**Measured 2026-08-03:** `.github/workflows/release.yml` is the **only** workflow in the repo, and
**no job in it runs a test.** Verified by sweep — no `bun test`, no `pytest`, no `test:e2e`, nothing.

What CI does today:

| Job | Does | Does NOT |
|---|---|---|
| `build` | `python -m build` + `twine check` on `crucible-axi` | run any test; build the npm artifact |
| `create-release` | cuts the GitHub Release from a tag on master | verify anything about the code |
| `publish-pypi` / `publish-npm` | publish both artifacts | verify anything about the code |

So **CI is a publisher, not a verifier.** Its own comment says *"packaging breakage surfaces on PRs,
not on release day"* — which is accurate and exactly the limit: it proves the package **builds**,
never that the code **works**.

**The consequence.** Every gate this project has — no-mistakes, bun (1299), python (679), e2e
(40/40) — is **local-only**. A tag push publishes whatever sits at that commit. Nothing in the
pipeline would stop an untested, or a broken, release. The release plan mitigates this with
discipline (DN §3 Steps 3-4), but discipline is not a gate, and the whole argument of CR-CRU-053 and
CR-CRU-060 is that an ambient guarantee nobody owns is the one that rots.

**Two smaller gaps from the same read:**
- CI builds only the **Python** artifact. The npm side publishes `bin/`, `src/`, `public/` straight
  from source with no build or pack step — legitimate for a Bun/TS package that ships TypeScript,
  but it means a packaging break on the server side surfaces only at publish time.
- `package.json` already defines `test` (`bun test`) and `test:e2e` (`bunx bddgen && bunx playwright
  test`). The commands CI needs are sitting there unused.

## Scope

### §S1 — A CI job that runs the bun suite
Run `bun test` on push and pull_request. This is the 1299-test suite that gates every CR locally.

### §S2 — A CI job that runs the Python suite
Run the Python regression. Note the cross-stack rule (CR-CRU-045 §S3): a change to
`clients/*-crucible.py` requires BOTH gates, so CI must carry both or it under-enforces a rule the
project already holds itself to locally.

### §S3 — A CI job that runs e2e
`bun run test:e2e`. 🚨 **This is the one with a trap.** CR-CRU-052 found that a default e2e run
resolves its database through `resolveDbPath`'s fallback chain and, without `CRUCIBLE_DB`, lands on
a **persistent user-level path**. On a CI runner that is a fresh container each time, so the blast
radius is nil — but the job must set `CRUCIBLE_DB` explicitly anyway, for the same reason
`playwright.config.ts` now does: isolation must be *declared*, never inherited from an ambient
property of the environment.

Expected: 40/40 (CR-CRU-060). Playwright needs its browsers installed in the runner.

### §S4 — Decide what BLOCKS
Running tests and ignoring them is theatre. Decide and record:
- Do failures block a **publish**, or only report? (A publish job that runs after a failed test job
  and does not depend on it is the same gap in a new shape.)
- Does the release path require the test jobs to have passed on that commit?

Prefer wiring `publish-*` to `needs:` the test jobs over adding a second, parallel guard — one
dependency graph, not two enforcement mechanisms that can disagree.

### §S5 — Build the server artifact in CI too
Add a build/pack step for `@anthill-tec/crucible-server` so packaging breakage on the server side
surfaces on push like the Python side already does, rather than at publish time.

## Acceptance criteria
- [ ] A CI run on push executes the bun suite and its result is visible on the commit — asserted by
      a real run, not by reading YAML.
- [ ] The Python suite likewise.
- [ ] The e2e suite likewise, with `CRUCIBLE_DB` set explicitly in the job env.
- [ ] A deliberately failing test **fails the workflow** — asserted by an actual red run, then
      reverted. A test job that cannot go red proves nothing.
- [ ] §S4's blocking decision is implemented and recorded — publishes cannot proceed on a commit
      whose tests failed.
- [ ] The server artifact is built/packed in CI (§S5).
- [ ] `DN-release-process.md` §3 Step 4 is updated to say which gates CI now owns versus which stay
      local.

## Non-goals
- Changing the release/publish flow itself (CR-CRU-041, CR-CRU-061).
- Coverage thresholds or CI-enforced coverage gates — worth doing, separate concern.
- Migrating to a PR-based workflow. This project uses git-flow with direct merges; CI must fit that,
  not the reverse. (Same constraint that makes `no-mistakes`' PR-based `ci` step inapplicable —
  DN §3 Step 3.)
- Self-hosted runners, matrix builds, caching strategy.

## Risk
- **CI minutes and wall-clock.** The bun suite is ~358s and e2e ~57s locally. Running all three on
  every push is real cost; consider what runs on push versus what runs on the release path only.
  Whatever is decided, the RELEASE path must run all of them.
- **e2e in CI needs browsers and a server.** Playwright installs browsers; the config spawns the
  server itself. The scratch-cwd + `CRUCIBLE_DB` isolation CR-052 built must hold on a runner too —
  verify rather than assume, since that isolation was silently broken for weeks on a developer
  machine and nobody noticed.
- **A green CI that never fails is worse than no CI**, because it manufactures confidence. The AC
  requiring a deliberately-red run exists for exactly that reason.
