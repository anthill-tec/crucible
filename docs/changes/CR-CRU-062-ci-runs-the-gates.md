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

### 🚨 §S0 — The event-boundary constraint that governs every other section
**Found at gap analysis; get this wrong and the gate is decorative.**

`publish-pypi` and `publish-npm` are `if: github.event_name == 'release'`. `create-release` is
`if: push && master`. **These are DIFFERENT workflow runs**, and GitHub Actions' `needs:` only
orders jobs *within a single run*. A test job scoped to `push`/`pull_request` therefore does not
exist in the release run at all.

Consequences, both bad:
- A publish job that `needs:` a **skipped** job is itself skipped — so a release would publish
  **nothing**, silently.
- Working around that with `if: always()` on the publish would defeat the gate entirely.

**Therefore the test jobs must carry NO event-restricting `if`**, so they run on push, PR **and**
release. That is what makes `needs:` a real gate rather than a decoration. Do not "optimise" CI
minutes by scoping them to push — that is precisely the change that would look correct in review
and fail at the only moment it matters.

### §S1 — A CI job that runs the bun suite
Run `bun test` — on every event (see §S0), not push-only. This is the ~1308-test suite that gates
every CR locally.

### §S2 — A CI job that runs the Python suite
**Measured at gap analysis:** `python3 -m unittest discover -s tests/client -t .` → **683/683 with
NO server**, verified by re-running with `CRUCIBLE_URL` pointed at a dead port. Use that.

⚠ Do **not** use the client's `regression` verb: it needs `CRUCIBLE_PROJECT_KEY` and a live Crucible
server to ingest into, neither of which exists on a runner. It is the orchestrator's tool, not CI's.

Note the cross-stack rule (CR-CRU-045 §S3): a change to `clients/*-crucible.py` requires BOTH gates,
so CI must carry both or it under-enforces a rule the project already holds itself to locally.

### §S3 — A CI job that runs e2e
`bun run test:e2e`. 🚨 **This is the one with a trap.** CR-CRU-052 found that a default e2e run
resolves its database through `resolveDbPath`'s fallback chain and, without `CRUCIBLE_DB`, lands on
a **persistent user-level path**. On a CI runner that is a fresh container each time, so the blast
radius is nil — but the job must set `CRUCIBLE_DB` explicitly anyway, for the same reason
`playwright.config.ts` now does: isolation must be *declared*, never inherited from an ambient
property of the environment.

Expected: 40/40 (CR-CRU-060). Playwright needs its browsers installed in the runner.

### §S4 — What BLOCKS: extend the existing `needs:` graph, add nothing new
**Gap analysis correction:** this section originally asked to "decide" the mechanism. There is
nothing to decide — all five jobs already `needs: build`, so the dependency graph IS the enforcement
mechanism. Gating requires only more edges on it: `publish-pypi` and `publish-npm` gain
`needs: [build, <the test jobs>]`.

Do NOT add a second, parallel guard (a status check, an `if:` condition consulting a prior run).
Two mechanisms can disagree; one graph cannot disagree with itself. Combined with §S0's no-`if`
rule, this makes a failed suite block a publish by construction.

### §S5 — Build the server artifact in CI too
Add a build/pack step for `@anthill-tec/crucible-server` so packaging breakage on the server side
surfaces on push like the Python side already does, rather than at publish time. It must carry NO
event-restricting `if` (§S0) — otherwise it surfaces nothing on push, which is the entire point.

🚨 **Use `npm pack --dry-run`, NOT `npm publish --dry-run`. Measured 2026-08-04:**
```
$ npm publish --dry-run --access public
npm error You must specify a tag using --tag when publishing a prerelease version.
```
`package.json` currently holds the `2.0.0-alpha.1` scaffold placeholder, and npm refuses to
dry-run-publish a **prerelease** version without an explicit `--tag`. `npm pack --dry-run` has no
such constraint, is network-free, and still resolves the `files` list — which is what this section
actually needs.

**Also worth asserting: the packed tarball CONTAINS the declared bin entrypoint.** `package.json`
declares `files: ["bin/", "src/", "public/"]` and `bin: {"crucible-server": "bin/crucible-server.mjs"}`.
A `files` list that silently stopped shipping the executable would today surface only when someone
installed the published package and it failed to run. Verified provable in-runner: `npm pack
--dry-run` lists `bin/crucible-server.mjs` in its output.

**Note on the pre-existing `dry-run-npm` job:** it runs `npm publish --dry-run --access public` and
therefore fails from any ref whose committed version is a prerelease. That is tolerable for its own
purpose — it is the `workflow_dispatch` rehearsal, dispatched from a `release/*` branch where
CR-CRU-061 §S7 has already aligned the manifest to a release version. It is NOT a model for §S5's
unconditional job, which must work on ordinary pushes from `develop`.

## Acceptance criteria
- [ ] 🚨 The test jobs carry NO event-restricting `if`, so they run on the `release` event too —
      asserted (§S0). Without this the gate is inert.
- [ ] `publish-pypi` and `publish-npm` `needs:` the test jobs — asserted on the parsed workflow, not
      by eye.
- [ ] A CI run on push executes the bun suite and its result is visible on the commit — asserted by
      a real run, not by reading YAML.
- [ ] The Python suite likewise, via `unittest discover` with no server — asserted.
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
  every push is real cost. ⚠ **But §S0 forecloses the obvious saving**: scoping the test jobs to
  push-only makes them absent from the release run, which either skips the publish outright or
  forces an `if: always()` that defeats the gate. If cost must come down, reduce it INSIDE the jobs
  (caching, sharding) — never by restricting which events they run on.
- **e2e in CI needs browsers and a server.** Playwright installs browsers; the config spawns the
  server itself. The scratch-cwd + `CRUCIBLE_DB` isolation CR-052 built must hold on a runner too —
  verify rather than assume, since that isolation was silently broken for weeks on a developer
  machine and nobody noticed.
- **A green CI that never fails is worse than no CI**, because it manufactures confidence. The AC
  requiring a deliberately-red run exists for exactly that reason.

## Implementation Notes
- **Union regression at the gate: 2009 passing / 0 failing** (bun 1326 + python 683), coverage
  87.6%/87.0% bun.
- **🚨 §S0 was found at gap analysis and would have made the entire CR decorative.** `needs:` orders
  jobs only WITHIN a workflow run. Publishes fire on the `release` event, `create-release` on
  push-to-master — different runs. Test jobs scoped to push/PR simply do not exist in the release
  run, so a publish that `needs:` them is itself SKIPPED and the release silently publishes nothing.
  The original spec said "run on push and pull_request", which is precisely that mistake. All four
  new jobs therefore carry NO event-restricting `if`, verified by YAML parse (orchestrator + VERIFY).
  The Risk section records that this forecloses the obvious CI-minutes saving — cost must come down
  inside the jobs, never by restricting events.
- **`npm publish --dry-run` FAILS today** — measured: *"You must specify a tag using --tag when
  publishing a prerelease version"*, because the manifest holds the `2.0.0-alpha.1` scaffold value.
  §S5 uses `npm pack --dry-run` instead: network-free, no prerelease constraint, and it still
  resolves the `files` list. The pre-existing `dry-run-npm` job gets away with the publish form only
  because it is dispatched from a `release/*` branch where CR-061 §S7 has aligned the manifest.
- **The pack job asserts the bin entrypoint SHIPS**, not merely that packing succeeds. `npm pack
  --dry-run`'s listing is npm's own resolution of `files`/`.npmignore` precedence, so a typo'd glob
  or dropped `bin/` entry fails the job rather than failing a user's first `npx`. RED proves this by
  EXECUTING the extracted `run:` script, not by parsing YAML — a parse only shows the text says
  `npm pack`; execution shows the command resolves the entrypoint against the real manifest state.
- **The Python job is genuinely server-free** — 683/683 with `CRUCIBLE_URL` pointed at a dead port,
  verified independently twice. The client's `regression` verb was explicitly rejected: it needs
  `CRUCIBLE_PROJECT_KEY` and a live server to ingest into, so it is the orchestrator's tool, not
  CI's.

## 🚨 CARRY-FORWARD — five facets provable ONLY by a real push/release run
This CR's subject is CI, which cannot be executed locally. VERIFY enumerated what remains open; it
is recorded here rather than quietly ticked, because an incomplete list is worse than none.

1. A real push executes `test-bun` and the result is visible on the commit.
2. `test-e2e` genuinely runs in the runner container — Playwright's `--with-deps chromium` install
   and the server spawn under `${{ github.workspace }}/e2e-scratch/…`. **CR-052's scratch-cwd +
   `CRUCIBLE_DB` isolation has been reasoned about on a runner, never proven there** — and that same
   isolation was silently broken for weeks on a dev machine before anyone noticed.
3. **A deliberately RED commit fails the workflow, then is reverted.** This is the AC the whole CR
   exists to guarantee and it remains unexercised. A CI that cannot fail manufactures confidence.
4. `pack-server` succeeds on `ubuntu-latest` + `actions/setup-node@v4` (node 22) — proven only on
   this machine's npm/node.
5. On a real `release` event, the publishes genuinely WAIT on the three test jobs. The YAML topology
   is sound by parse, but GitHub Actions' live scheduling and skip-propagation are unverified.

**Item 3 is the one to do deliberately**, not opportunistically: push a trivial red commit to a
throwaway branch, observe the workflow fail, revert. Until then the gate is designed but never
demonstrated.
