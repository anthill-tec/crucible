# DN — Release process: pre-release gates, packaging, and CI handover

**Status:** DRAFT — awaiting user ratification
**Date:** 2026-08-03
**Author:** Mainline orchestrator (`vidushi`)
**Design inputs:** `RELEASING.md` (operational manual, CR-CRU-041), `scripts/release.sh`,
`.github/workflows/release.yml`, CR-CRU-009 (installer), CR-CRU-013 (gate events),
CR-CRU-041 (release mechanism + composite lockstep)

**What this DN is for.** `RELEASING.md` already documents *how* to cut a release. It does not say
*what must be true before you start*, in what order the pre-release gates run, or who owns each
one. This DN fixes that ordering and records the readiness state measured on 2026-08-03. It is the
plan; `RELEASING.md` remains the manual.

---

## 1. Measured starting state (2026-08-03)

Everything below was verified against the repo, not recalled.

### 1.1 Already built and working — do not rebuild

| Capability | Where | State |
|---|---|---|
| Release driver with preflight guards | `scripts/release.sh` (`set-version` · `checkpoint` · `finish` · `status`) | present |
| CI publish chain | `.github/workflows/release.yml` — `build` → `create-release` → `publish-pypi` ∥ `publish-npm`, plus `publish-testpypi` and `dry-run-npm` on dispatch | present |
| Operational manual | `RELEASING.md` | present, comprehensive |
| Composite lockstep | runtime pin: `crucible_axi.__version__` selects `@anthill-tec/crucible-server@<that version>`; `CRUCIBLE_SERVER_VERSION` is the only escape hatch | present, **10 tests** in `tests/client/test_crucible_axi_version_pin.py` |
| no-mistakes → Crucible | `bun-crucible.py gate-run --intent … --agent …` proxies `axi run` and posts throttled interim snapshots then a final sealed gate event (CR-CRU-013) | present; `no-mistakes` is on PATH at `~/.local/bin/no-mistakes` |
| GitHub repo | `anthill-tec/crucible`, default branch `develop`, **PRIVATE** | exists; `gh` authenticated as `antojk` |

### 1.2 🚨 Blockers and corrections — measured, not assumed

| # | Premise | Measured reality |
|---|---|---|
| B1 | *"We already have set a tag at 0.1.0"* | **No tags exist.** `git tag -l` → 0 locally; `git ls-remote --tags origin` → empty. Nothing is tagged. |
| B2 | package.json is at the release version | **`package.json` = `2.0.0-alpha.1`**, not `0.1.0`. `release.sh set-version` exists precisely to reconcile this, and `finish` re-checks it against the tag. |
| B3 | The repo reflects the work | **641 commits unpushed on `develop`.** Remote last saw `2026-07-16`; local HEAD is `2026-08-03`. The entire Wave-4 body of work exists only locally. **CI cannot fire on code GitHub has never seen.** |
| B4 | git-flow is configured for tagging | **`gitflow.prefix.versiontag` is NOT set.** `release.sh finish` guards this as a documented footgun and will refuse to run. One-time `git config`. |

### 1.3 Open setup items (human-owned)

| # | Item | Note |
|---|---|---|
| S1 | **PyPI + TestPyPI pending Trusted Publishers** | Publishing is OIDC — there are no API tokens in this repo by design. A PyPI *account* is not the same as a *pending Trusted Publisher*, which is registered per project + workflow + environment. `RELEASING.md` §"PyPI and TestPyPI" has the exact field values. |
| S2 | **npm org `@anthill-tec` does not exist** | User-confirmed. Blocks `publish-npm`. |
| S3 | **`NPM_TOKEN` not set** | ⚠ **Footgun:** `publish-npm` *detects the absent token and skips with a notice* — the release would report success having published **PyPI only**. That directly violates the lockstep rule in `RELEASING.md`: *"do not publish one artifact alone."* See §4. |
| S4 | GitHub Environments (`pypi`, `testpypi`) + `RELEASE_PAT` | Status unverified. `RELEASING.md` documents both. |
| S5 | Repo is **PRIVATE** | `publish-npm` runs `npm publish --provenance`. Provenance attestation generally requires a public repository. **Verify before the real publish** — a `dry-run-npm` dispatch is the cheap probe. |

---

## 2. The ordering decision

The user's instinct — *"probably the first step after the Git release step is to run the
no-mistakes on the codebase"* — is adopted, and this DN makes the reason explicit.

**Integrity before packaging.** no-mistakes validates the *source*. Packaging validates the
*artifact*. Running packaging first means a packaging failure is ambiguous — bad code, or bad
packaging? Running integrity first makes every later failure attributable to packaging alone.

**Gate order is therefore: branch → integrity → packaging → rehearsal → finish → CI publish.**

Two properties this ordering buys:
- Every gate before `finish` is **reversible**. The release branch can be deleted and re-cut. The
  first irreversible act is the tag push, and everything destructive happens after it, in CI.
- The **rehearsal** (TestPyPI + npm dry-run) exercises the identical CI path against throwaway
  targets, so the real publish is a repeat of something already proven, not a first attempt.

---

## 3. The plan

### Phase 0 — Pre-flight (do BEFORE cutting the release branch)

Each item is a hard gate; none is optional.

| Step | Action | Owner | Blocker |
|---|---|---|---|
| 0.1 | `git config gitflow.prefix.versiontag v` | orchestrator | B4 |
| 0.2 | **Push develop to origin** — 641 commits. Nothing downstream works until GitHub has the code. | orchestrator | B3 |
| 0.3 | Register **pending Trusted Publishers** on PyPI + TestPyPI (`RELEASING.md` has the field table) | **user** | S1 |
| 0.4 | Create the **npm org `@anthill-tec`**, then generate an automation `NPM_TOKEN` and add it as a repo secret | **user** | S2, S3 |
| 0.5 | Confirm GitHub Environments `pypi` / `testpypi` exist and `RELEASE_PAT` is set | **user** | S4 |
| 0.6 | Decide the repo's visibility for provenance — publish public, or drop `--provenance` | **user** | S5 |
| 0.7 | Confirm the target version. `0.1.0` is the queue's stated target; `package.json` currently says `2.0.0-alpha.1`. **These must be reconciled deliberately, not silently** — see §5. | **user** | B1, B2 |

### Phase 1 — Cut the release branch

```bash
git flow release start 0.1.0        # from develop
```
Reversible. `scripts/release.sh` refuses to run anywhere but a `release/*` or `hotfix/*` branch, so
this must come first.

### Phase 2 — Integrity gate (no-mistakes, tracked in Crucible)

```bash
python3 clients/bun-crucible.py gate-run --intent "0.1.0 release integrity" --agent vidushi
```

This is the step the user asked to lead with. It proxies the `no-mistakes` utility, streams
throttled interim snapshots while the run is in flight, and posts a **final sealed gate event** into
Crucible — so the release gate becomes evidence on the project timeline (CR-CRU-013's whole point),
not a claim in a chat log.

**Gate:** the sealed gate's outcome must be `passed`. A `failed` outcome ends the release; fix on
`develop`, re-merge, re-run. Do not proceed on a partial pass.

### Phase 3 — Full-stack regression

Union regression (all tests except e2e) **plus** e2e, which is now meaningful — CR-CRU-060 took the
suite to 40/40 green for the first time.

- bun regression with coverage
- python regression with coverage
- `bun run test:e2e` — 40/40 expected

**Gate:** all three green. Any failure ends the release.

### Phase 4 — Packaging build + artifact test

Build both artifacts and test them as artifacts, not as a source tree.

| Step | Action | Proves |
|---|---|---|
| 4.1 | `scripts/release.sh set-version 0.1.0` | the manual manifest matches the intended tag |
| 4.2 | Build the Python sdist/wheel | `crucible-axi` packages cleanly; hatch-vcs derives the version from the tag |
| 4.3 | Build/pack the npm tarball (`npm pack`) | `@anthill-tec/crucible-server` packages cleanly; the file list is what we intend to ship |
| 4.4 | **Install the built wheel into a throwaway venv** and run the client fleet's `--help` + one real verb against an ephemeral server | the packaged client works *as installed*, not just from the repo |
| 4.5 | **Verify the composite pin resolves** — the installed `crucible_axi.__version__` must select `@anthill-tec/crucible-server@0.1.0`, never `latest` | the lockstep contract holds at runtime, not just in tests |

**Gate:** 4.4 and 4.5 are the ones that matter. A wheel that builds but doesn't run is not a
release. Note 4.5 can be proven *before* the npm package exists by asserting the resolved
coordinate string, with the actual fetch deferred to Phase 5.

### Phase 5 — Rehearsal against throwaway targets

```bash
scripts/release.sh checkpoint        # dispatches release.yml → TestPyPI + npm dry-run
```

Exercises the **identical CI path** — same workflow, same jobs, same OIDC — against TestPyPI and
`npm publish --dry-run`. Repeat until clean.

**Gate:** TestPyPI upload succeeds **and** the npm dry-run succeeds. 🚨 If `NPM_TOKEN` is still
absent, `publish-npm` will *skip rather than fail* — treat a skip as a **failed gate**, not a pass
(§4).

### Phase 6 — Finish (the first irreversible act)

```bash
scripts/release.sh finish 0.1.0
```

Preflight guards → `git flow release finish` → tag `v0.1.0` → push `master` + `develop` + tags.

**This is the point of no return.** The tag push is what CI keys on.

### Phase 7 — CI takes over

```
push master → create-release → GitHub Release (published)
                                  ├─ publish-pypi  → crucible-axi → PyPI
                                  └─ publish-npm   → @anthill-tec/crucible-server → npm
```

No human step. **Watch both jobs to completion.**

### Phase 8 — Post-publish verification

Prove the delivered thing works from the registries, not from the repo:
- `uv`-install `crucible-axi==0.1.0` into a clean environment
- Confirm it provisions `@anthill-tec/crucible-server@0.1.0` — the version-locked pair the user's
  bundling strategy specifies
- Run one real verb end-to-end against a server it provisioned itself

Only after this does the release-gate item **"per-release Model-B intimation"** fire: one message
enumerating `--role`, `--source`, STATUS-CONTRACT 2.0.0 and the bundle version they land in.

---

## 4. 🚨 The one-artifact-published hazard

`RELEASING.md` states the rule: *"do not publish one artifact alone. If a publish job fails after
the other succeeded, fix forward with a new patch release."*

But `publish-npm` currently **detects a missing `NPM_TOKEN` and skips with a notice**, explicitly
saying *"PyPI is unaffected."* That is a sensible degradation for a repo that isn't ready to publish
npm — and a **release-day trap**, because the run goes green having shipped half the pair. A
`crucible-axi 0.1.0` on PyPI that pins `@anthill-tec/crucible-server@0.1.0` is **broken on install**
if that npm version does not exist.

**Decision required (§5).** Either:
- **(a)** complete S2+S3 before releasing, so the skip cannot trigger; or
- **(b)** make the skip a hard failure when the ref is a release tag — degrade on branch pushes,
  refuse on a release. Recommended regardless of (a), as a standing guard.

## 5. Open decisions for the user

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| D1 | **Release version: `0.1.0`, or reconcile with `2.0.0-alpha.1`?** | The queue targets 0.1.0; the npm manifest says 2.0.0-alpha.1. Publishing 0.1.0 *after* an alpha implies a version going backwards on npm. This is a product-identity call. |
| D2 | **Repo visibility** — publish public (enables `--provenance`) or drop provenance? | Affects the workflow and is a disclosure decision. |
| D3 | **npm skip → hard failure on release tags?** (§4 option b) | Changes CI behaviour; recommended but is a policy choice. |
| D4 | **Does the 0.1.0 scope still hold** after Wave 4 grew well beyond the original queue? | Membership is the user's call, always. |

## 6. What this DN does NOT cover

- Hotfix flow — `release.sh` supports `hotfix/*`; unchanged by this DN.
- Model-B's skills bundle — theirs to release; we owe one intimation, not a coordinated release.
- 0.2.0 scope.
