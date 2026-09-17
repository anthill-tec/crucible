# CR-CRU-137 — the pipeline's own defaults are chosen, not inherited

**Type** hotfix · **Wave** 7 (0.2.2) · **Depends on** CR-CRU-087, CR-CRU-134, CR-CRU-136 · **Status** PENDING

## Problem

The 0.2.0 release shipped, but not on the first pass of a green tree. Five defects share one shape:
a figure or declaration the pipeline needs was left to whatever a tool defaults to, so the value is
real, load-bearing, and owned by nobody.

**§S1 cost a release.** Two tests failed in CI on wall-clock alone, on trees whose suites were green:

| Run | Test | Took | Budget |
|---|---|---|---|
| `35077837163` | `cr009-release-bundle` → `published tarball contains bin/, src/, and public/` | 5101 ms | 5000 ms |
| `35080360789` attempt 1 | `CR-CRU-129 §S1` → retention sweep at this project's real shape | 6245 ms | 5000 ms |

Neither is a performance assertion; both assert content. The second one failed `test-bun` on the
**master merge commit**, which skipped `create-release` and therefore the whole publish chain — the
release reached PyPI and npm only after the failed job was re-run by hand. The first one was
"fixed" by annotating two tests (`6515b8f`); that is instance-patching, and the second failure
arrived the same day from a different file.

**§S2 is a completed CR whose fix never landed.** CR-CRU-087 root-caused CI floating to the newest
bun and chose a pin in ONE place — `package.json`'s `packageManager`, which `setup-bun` resolves
first — explicitly rejecting four duplicated `bun-version` entries. Measured today: `packageManager`
does not appear in `package.json`, `git log -S'bun-version'` returns exactly one commit (`48223ad`,
filed during the 0.2.0 endgame, four sites), and `tests/ci-toolchain-provisioning.test.ts` contains
zero assertions naming either mechanism. The queue records CR-087 `COMPLETED (0.2.0)` while its own
spec still reads `Status: PENDING`. An unpinned toolchain is what produced CR-CRU-136's failure
months later.

**§S3–§S5** are the same defect in three smaller places: the published npm package declares no
licence (npm's registry page renders `License: none`), the queue header still names the release that
has already shipped, and six workflow actions are being force-migrated off Node 20 by GitHub.

Measured against bun 1.4.2 (the pinned version), so §S1's mechanism is not assumed:

- `bunfig.toml` `[test] timeout = 12000` is **silently ignored** — a 7 s test still died at 5000 ms.
- `bun test --timeout 12000` **is** honoured — the same test passed in 7.00 s.
- A per-test third argument **overrides** the CLI default — a test annotated `8000` passed in 3.00 s
  under `--timeout 1000`. So raising the default cannot weaken the suite's existing explicit
  budgets (`30_000` ×5, `60_000` ×3, `120_000` ×8, `180_000` ×5, `300_000` ×1, and the deliberate
  tight ones: `5` ×13, `50`, `0` ×2).

## Scope

### §S1 — the suite's default per-test budget is the suite's own figure

**Surfaces (verified 2026-09-16):** `.github/workflows/release.yml:146` runs bare `bun test`;
`clients/bun-crucible.py:489-497` (`_bun_test_cmd`) builds the local gate's invocation and takes its
flag contract from `_bun_test_report_flags` at `:478-486`, the "spelled in ONE place" pattern
CR-CRU-133 §S2 established.

The default per-test timeout becomes **30000 ms**, declared by this project rather than inherited
from bun. 30 s is chosen against the two measured failures (5.1 s, 6.2 s) and the suite's most
common existing annotation; a genuine hang still fails inside a bounded time instead of stalling a
runner.

Both invocation paths carry it: the client's command builder gains the flag beside the report
contract, and the CI step names it too. CI does not shell through the client, so the two cannot be
one physical constant — therefore the value is **derived, not retyped**, exactly as CR-CRU-134
requires: a test reads the client's declared figure and asserts the workflow's step matches it, so a
change to one that is not made to the other fails the suite.

The two annotations added by `6515b8f` to `tests/cr009-release-bundle.test.ts`
(`NPM_PACK_TIMEOUT_MS = 60_000`) stay — `npm pack` cold start is a per-test fact, and 60 s remains
above the new default.

### §S2 — one bun version, declared once and guarded

The bun version is declared in exactly ONE place. CR-CRU-087 §S1's choice (`packageManager`) is
adopted **only if** it survives this repo's npm usage: three jobs run real npm in this package
(`pack-server`'s `npm pack`, `dry-run-npm`'s `npm publish --dry-run`, `publish-npm`'s
`npm publish --provenance`), and npm reads `packageManager` itself. That interaction is settled by
building the artifact and running those commands, not by reading npm's documentation. If
`packageManager: bun@<version>` degrades any npm invocation, the single declaration stays
`bun-version` in the workflow and §S2 consolidates the four sites into one reusable reference
instead — the requirement is one declaration and a guard, not a particular file.

A guard test asserts the invariant that was missing: every `setup-bun` step resolves to a pinned
exact version, and the version is declared once.

CR-CRU-087's spec `Status:` is corrected to match what shipped, and its unlanded §S1 is recorded as
delivered here rather than left reading as complete.

### §S3 — the published package declares its licence

`package.json` carries no `license` field and the repository has no `LICENSE` file, so npm serves
`@anthill-tec/crucible-server` as `License: none`. Both are added; the licence text and SPDX
identifier are the user's call and this CR does not choose them.

### §S4 — the queue header and CR-087's status tell the current truth

`docs/changes/README.md:8` reads `**Target release:** 0.2.0`, which has shipped; it becomes the
release now being planned. No other table change: every prior release transition (0.1.0, 0.1.2,
0.1.3) is marked ONLY by the `Wave` column's own parenthetical qualifier — there has never been a
separate boundary row, and inventing one here would be new format with no precedent and no reader.

### §S5 — no workflow action is running on a deprecated runtime

GitHub deprecated Node 20 on the runners, so every action declaring `using: node20` is force-run on
Node 24 and each job emits a deprecation annotation naming its offenders. Measured on run
`35164711642` (the CR-CRU-139 merge), all five jobs are annotated; `.github/workflows/release.yml`
is the only workflow file, and six of its pins are the cause — `actions/checkout`,
`actions/setup-python`, `actions/setup-node`, `astral-sh/setup-uv`, `actions/upload-artifact` and
`actions/download-artifact`. Already clean and not to be touched: `oven-sh/setup-bun@v2` (already
`node24`) and `pypa/gh-action-pypi-publish@release/v1` (not a Node action, never annotated).

Each is moved to a version that targets a supported runtime natively. Two measured facts, because
each one is a way to get this wrong:

- **A floating major tag is not evidence.** `actions/upload-artifact@v5` and
  `actions/download-artifact@{v5,v6}` still resolve to `using: node20`; the node24 releases are
  further along than the obvious next major. The runtime a pin resolves to is read from that ref's
  own `action.yml`, never assumed from the version number.
- **The two artifact actions are a matched pair.** `build` uploads the `dist` artifact that both
  publish jobs download, and the newer download major exists specifically to understand the newer
  upload major's direct (unzipped) uploads. Bumping one without the other breaks that handoff, and
  the newer download major also turns artifact hash mismatches into errors by default.

Our invocations pass only inputs that survive these majors, and every job is `runs-on:
ubuntu-latest`, so no self-hosted runner needs a version floor. The bump is therefore expected to
be pins only — if any target major forces an input or job-logic change, that is a finding to
escalate, not to absorb silently.

### §S6 — this CR's own edits do not leave stale line-number citations behind

§S1's constant lands beside `_bun_test_report_flags` at `clients/bun-crucible.py:493`, and §S2's
consolidation touches the same file. Measured: 136 `bun-crucible.py:NNN` citations across 79 test
files sit at or below that point today, plus 2 `release.yml:NNN` citations in
`tests/cr009-release-bundle.test.ts` (its `RELEASE_PAT`/`NPM_TOKEN` secret-name assertions) near
§S1/§S2's edit sites, plus this CR's own two citations (`bun-crucible.py:489`, `release.yml:146`).
None of it is asserted at runtime — a citation that drifts stays silently wrong, which is why this
project's own history already shows the same defect shipping twice at smaller scale. This is a
ONE-TIME close-out sweep after every other §S's edits have landed, not a per-cycle escalation.

Out of scope: citations inside `docs/changes/*.md` for CRs already `COMPLETED` — those are
historical record of what a prior author observed, like a DN's dated note, not a living index.

## Acceptance criteria

**§S1**
- [ ] `clients/bun-crucible.py` declares the default per-test budget as a single named constant with
      the value `30000`, and `_bun_test_cmd` emits `--timeout 30000` in every invocation it builds,
      targeted and whole-suite alike.
- [ ] `.github/workflows/release.yml`'s `test-bun` step runs `bun test` with `--timeout 30000`.
- [ ] A test asserts the workflow's `--timeout` value **equals the figure read from the client** —
      changing either alone fails. It reads both files; it does not retype the number.
- [ ] A test asserts a per-test annotation still overrides the default, by running a real child
      `bun test` whose test is annotated above the default and observing it pass.
- [ ] `tests/cr009-release-bundle.test.ts` still declares `NPM_PACK_TIMEOUT_MS = 60_000` and both
      `npm pack` tests still pass it.
- [ ] `tests/client/test_gate_suite_outcome_reporting.py`'s `PRE_COMPOSITION_STEPS` fixture (the
      pre-merge gate's own frozen whole-suite argv, asserted by
      `test_a_single_suite_gate_runs_the_same_step_it_ran_before_the_composition`) is corrected to
      DERIVE its expected `--timeout` value from `clients/bun-crucible.py`'s declared constant,
      never a retyped `30000` — found during GREEN, missed by this CR's original AC list: §S1's own
      "every invocation it builds" necessarily changes the whole-suite argv this fixture pins, and a
      third physical copy of the number is exactly what AC3's derived-equality test exists to
      prevent.
- [ ] The full suite passes with no test relying on bun's 5000 ms default: run
      `bun test --timeout 5001` and `bun test --timeout 30000` and compare — no test may pass only
      because of the larger figure other than ones carrying their own annotation.

**§S2**
- [ ] The bun version appears in exactly one location in the repository; a grep for the other
      mechanism's key returns zero.
- [ ] A test asserts every `setup-bun` step in `release.yml` resolves to an exact pinned version
      (no floating range, no absent declaration), and fails if a fifth step is added without one.
- [ ] If `packageManager` is the chosen location: `npm pack`, `npm publish --dry-run` and `tsc`
      each run to success in a clean checkout with it present, evidenced by the commands' own
      output — not by reading npm docs.
- [ ] `docs/changes/CR-CRU-087-ci-bun-is-unpinned.md`'s `Status:` reads `COMPLETED (shipped
      2026-08-27 on master)` and its §S1 pin is recorded as delivered by this CR.

**§S3**
- [ ] `package.json` has a `license` field holding a valid SPDX identifier.
- [ ] A `LICENSE` file exists at the repository root and ships in the npm tarball — asserted by
      inspecting `npm pack --dry-run --json` output, not the `files` array.
- [ ] `tests/cr009-release-bundle.test.ts`'s tarball-contents test covers `LICENSE`.

**§S4**
- [ ] `docs/changes/README.md`'s `**Target release:**` names the release now being planned.

**§S5**
- [ ] Every `uses:` pin in `release.yml` resolves to a ref whose own `action.yml` declares a
      supported runtime — evidenced by reading each pinned ref's `action.yml`, not by the version
      number looking new.
- [ ] No job in a full `release.yml` run produces a Node-20 deprecation annotation — verified by
      reading a real run's annotations after the change, not by diffing the workflow.
- [ ] The `dist` artifact still survives the `build` → publish handoff after the artifact actions
      move, evidenced by a real run's publish job consuming it.
- [ ] `tests/ci-toolchain-provisioning.test.ts` asserts the pinned version of **every** action the
      workflow uses, enumerated from the workflow itself — so an action added later without a pin,
      or a pin silently downgraded, fails the suite. A guard covering only the actions listed today
      does not satisfy this.

**§S6**
- [ ] Every `bun-crucible.py:NNN` and `release.yml:NNN` line-number citation in the `tests/` tree,
      plus this CR's own two citations, is re-checked after every other §S's edit has landed; a
      citation whose target line no longer matches its comment's claim is corrected to the line
      that now holds it. Evidenced by re-reading each corrected citation's new line and confirming
      it names what the comment says — not by a line-count diff alone.
- [ ] `tests/project-namespace-tripwire.test.ts`'s `PROSE_CITATIONS.clients.head` reflects the
      actual measured count after this CR's edits land — found during C1 close-out: two new
      `CR-CRU-137` literals in `clients/bun-crucible.py` moved the true count from 862 to 864,
      reddening this guard and (via its own child-process pairing)
      `tests/help-surface-order-independence.test.ts` too, on content grounds unrelated to §S1's
      timeout work. Evidenced by re-running the classifier the guard names in its own comment.

## Estimated size

Small–medium. §S1 and §S2 carry the test work; §S3–§S5 are declarations and version bumps; §S6 is a
one-time close-out sweep once every other section's line-shifting edit has landed. No production
server or client behaviour changes — `_bun_test_cmd` gains a flag, nothing else moves.

## Risk

- **§S1 raises the default for 2541 tests** (measured 2026-09-17). A test that hangs now burns 30 s instead of 5 s. The
  measured defence is that explicit annotations still win, so the suite's tight budgets (`5`, `50`,
  `0`) are untouched; the exposure is limited to a genuine hang in an unannotated test.
- **§S2's npm interaction is genuinely unknown.** `packageManager` is read by npm as well as
  `setup-bun`, and this package runs npm in three jobs. The AC settles it empirically and the scope
  section names the fallback, so a bad interaction changes the location, not the requirement.
- **§S5 can break a job on an unrelated major-version change.** Action majors carry behaviour
  changes beyond the runtime; each bump is verified by a real run, which is why the AC reads the
  run's annotations rather than the diff. The sharpest exposure is the `dist` handoff: the artifact
  actions must move as a pair, and a mismatch shows up not in `build` but later, in a publish job
  that cannot find or verify the artifact — which on a tag ref is a job that uploads to PyPI.

## Non-goals

- Reducing how many times the suite runs per release (release branch, master, develop, then the
  release event — four full runs before a package uploads). Real, and a separate CR.
- Choosing the licence text or SPDX identifier — the user's decision.
- Any change to the publish gate. `needs: [build, test-bun, test-python, test-e2e]` on all four
  publishing jobs is correct and stays; §S1 removes a false red, it does not loosen a gate.
- The six retyped RUNBOOK figures deferred by CR-CRU-134 — still their own candidate CR.
