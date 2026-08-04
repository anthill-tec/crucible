# DN — Release process: pre-release gates, packaging, and CI handover

**Status:** RATIFIED 2026-08-03 (all four decisions closed by the user)
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
| Release driver with preflight guards | `scripts/release.sh` (`set-version` · `checkpoint` · `finish` · `status`) | present; `set-version` is housekeeping only since CR-CRU-061 §S2 (see 5.1) |
| CI publish chain | `.github/workflows/release.yml` — `build` → `create-release` → `publish-pypi` ∥ `publish-npm`, plus `publish-testpypi` and `dry-run-npm` on dispatch | present |
| Operational manual | `RELEASING.md` | present, comprehensive |
| Composite lockstep | runtime pin: `crucible_axi.__version__` selects `@anthill-tec/crucible-server@<that version>`; `CRUCIBLE_SERVER_VERSION` is the only escape hatch | present, **10 tests** in `tests/client/test_crucible_axi_version_pin.py` |
| no-mistakes → Crucible | `bun-crucible.py gate-run --intent … --agent … [--skip …]` (`--skip` shipped in CR-CRU-061 §S5, all five clients) proxies `axi run` and posts throttled interim snapshots then a final sealed gate event (CR-CRU-013) | present; `no-mistakes` is on PATH at `~/.local/bin/no-mistakes` |
| GitHub repo | `anthill-tec/crucible`, default branch `develop`, **PRIVATE** | exists; `gh` authenticated as `antojk` |

### 1.2 🚨 Blockers and corrections — measured, not assumed

| # | Premise | Measured reality |
|---|---|---|
| B1 | *"We already have set a tag at 0.1.0"* | **No tags exist.** `git tag -l` → 0 locally; `git ls-remote --tags origin` → empty. Nothing is tagged. |
| B2 | package.json is at the release version | `package.json` = `2.0.0-alpha.1`. **NOT a conflict — a scaffold placeholder** from `eab2080`, the FIRST commit of the v2 rebuild, untouched since. **Under CR-CRU-061 this stops mattering entirely**: `publish-npm` will SET the version from the tag, so a stale committed value can no longer affect a release. Nothing to decide. |
| B3 | The repo reflects the work | **641 commits unpushed on `develop`.** Remote last saw `2026-07-16`; local HEAD is `2026-08-03`. The entire Wave-4 body of work exists only locally. **CI cannot fire on code GitHub has never seen.** |
| B4 | git-flow is configured for tagging | **`gitflow.prefix.versiontag` is NOT set** — and under the user's bare-SemVer ruling it must be set to the EMPTY string, not `v`, and **not left unset** (git-flow aborts with `Fatal: Version tag not set`). `release.sh` used to hard-assert `"v"`; **CR-CRU-061 §S1 has shipped the corrected guard** (refuses unset AND any non-empty prefix). The repo-side work is done — **the per-clone `git config` at step 1.1 is still outstanding**, since `.git/config` is not version-controlled. |

### 1.2b 🚨 User rulings 2026-08-03 that the machinery does NOT yet implement

| Ruling | State today | Owner |
|---|---|---|
| **Tags are bare SemVer — `0.1.0`, not `v0.1.0`** | *As measured 2026-08-03:* the `v` prefix was hardcoded in **6 live sites** across `release.sh` and `release.yml`; a bare tag would make `create-release` find nothing and BOTH publish jobs refuse. **✅ SHIPPED — CR-CRU-061 §S1**: all six sites now match `^[0-9]+\.[0-9]+\.[0-9]+$`, the `#v` strips are gone, and `release.sh` asserts a set-and-empty `gitflow.prefix.versiontag`. | **CR-CRU-061 §S1** |
| **Packaging takes the version from the GitHub tag automatically** | ✅ Python already did (hatch-vcs, `pyproject.toml:7,32`). *As measured:* npm did NOT — `package.json` was hand-bumped and CI merely *verified* it. **✅ SHIPPED — CR-CRU-061 §S2**: `publish-npm` now runs `npm version --no-git-tag-version --allow-same-version "$VERSION"`, SETTING the manifest from the tag, so a stale committed value cannot fail a release. | **CR-CRU-061 §S2** |

**CR-CRU-061 was a release blocker and has landed** (§S1/§S6, §S2, §S5, §S4). No tag exists yet, so
the format was still free; once `0.1.0` is cut it is published history on two registries — and the
shape it will be cut in is now **bare `0.1.0`**.

### 1.3 Open setup items (human-owned)

| # | Item | Note |
|---|---|---|
| S1 | **PyPI + TestPyPI pending Trusted Publishers** | Publishing is OIDC — there are no API tokens in this repo by design. A PyPI *account* is not the same as a *pending Trusted Publisher*, which is registered per project + workflow + environment. `RELEASING.md` §"PyPI and TestPyPI" has the exact field values. |
| S2 | **npm org `@anthill-tec` does not exist** | User-confirmed. Blocks `publish-npm`. |
| S3 | **`NPM_TOKEN` not set** | ⚠ `publish-npm` *detects the absent token and skips with a notice* — a release would report success having published **PyPI only**, violating the lockstep rule *"do not publish one artifact alone."* **Resolution (user): fix the setup, not the symptom** — the org + token land in Setup step 1.4, so the skip is unreachable on a release. No CI guard is added. |
| S4 | GitHub Environments (`pypi`, `testpypi`) + `RELEASE_PAT` | Status unverified. `RELEASING.md` documents both. |
| S5 | Repo is **PRIVATE** | **Resolved: goes PUBLIC at release** (user, 2026-08-03) — CI does not run otherwise. `npm publish --provenance` then works for free. |

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

**On the naming.** An earlier draft used "Phase 0/1/2…", which is invented jargon that says nothing
about what happens. The steps below are named for what they DO. Step 1 is SETUP — one-time
prerequisites that are not part of a release at all; steps 2-9 are the release itself, in order.

```
  SETUP (once)  ─┐
                 │
  2 cut branch ──┤  reversible — delete the branch, re-cut
  3 NO-MISTAKES ─┤  ← integrity gate, FIRST, on the source
  4 full test   ─┤
  5 package     ─┤  ← build + install + run the artifacts
  6 rehearse    ─┘  ← TestPyPI + npm dry-run, same CI path
  ─────────────────────────────────────────────
  7 finish      ── ⚠ tag push = POINT OF NO RETURN
  8 CI publish  ──    PyPI ∥ npm, no human step
  9 verify      ──    install from the registries
```


### Step 1 — SETUP (one-time; done before any release, not part of one)

These are account/repo facts that must be true before a release can work at all. They are not
release steps — they are prerequisites, done once and then true forever. A release never repeats
them.

Each item is a hard gate; none is optional.

| Step | Action | Owner | Blocker |
|---|---|---|---|
| 1.1 | `git config gitflow.prefix.versiontag ""` — bare SemVer, no `v`. 🚨 **Set-and-empty, never unset**: measured under CR-CRU-061 §S1, git-flow aborts with `Fatal: Version tag not set` when the key is absent, so `release.sh finish`'s guard refuses BOTH unset and any non-empty prefix (shipped) | orchestrator | B4 |
| 1.2 | **Push develop to origin** — 641 commits. Nothing downstream works until GitHub has the code. | orchestrator | B3 |
| 1.3 | Register **pending Trusted Publishers** on PyPI + TestPyPI (`RELEASING.md` has the field table) | **user** | S1 |
| 1.4 | Create the **npm org `@anthill-tec`**, then generate an automation `NPM_TOKEN` and add it as a repo secret | **user** | S2, S3 |
| 1.5 | Confirm GitHub Environments `pypi` / `testpypi` exist and `RELEASE_PAT` is set | **user** | S4 |
| 1.6 | **Make the repo PUBLIC** — user-decided 2026-08-03: *"we will make it public during release, the CI wont run otherwise"*. Provenance follows for free. | **user** | S5 |

⚠ **B2 (`package.json` = the `eab2080` scaffold placeholder) is NOT a SETUP item.** An earlier
draft listed `set-version 0.1.0` here; that is impossible — `release.sh` refuses to run outside a
`release/*` or `hotfix/*` branch, and Setup runs on `develop`. It is already correctly placed at
**step 5.1**, after the release branch exists. The version itself is not in question: the storyboard
fixes it at **0.1.0**, then 0.2.0.

### Step 2 — CUT THE RELEASE BRANCH

The git-flow release start. Everything from here until Step 6 is reversible: delete the branch and re-cut.

```bash
git flow release start 0.1.0        # from develop
```
`scripts/release.sh` refuses to run anywhere but a `release/*` or `hotfix/*` branch, so
this must come first.

### Step 3 — INTEGRITY GATE — **no-mistakes** (the first gate, as specified)

🔷 **This is the no-mistakes run.** It is the FIRST thing that happens after the branch is cut,
before any packaging, because it validates the SOURCE. Packaging validates the ARTIFACT; if
packaging ran first, a failure would be ambiguous between the two.

**What no-mistakes actually is** (measured 2026-08-03, not assumed). A *local git proxy that
validates code before pushing to the configured target*. It is initialized on this repo — gate
`~/.no-mistakes/repos/3f4e6ab87dd8.git`, target `https://github.com/anthill-tec/crucible.git`,
daemon running. Its pipeline:

```
rebase → review → test → document → lint → ci        (auto_fix keys, ~/.no-mistakes/config.yaml)
                                          └── PR-based tail
```

**🚨 The tail does not fit this project, and that is the marriage problem.** The `ci` step is
explicitly PR-shaped: `ci_timeout: "168h"` bounds *"how long the CI monitor babysits an **open PR**
with no base-branch movement"*, and test-evidence artifacts are committed so they *"render directly
on **the PR**"*. **This project has no PRs** — git-flow, direct merges to `develop`. Left alone, the
`ci` step would wait on a PR that never exists, for up to a week.

**How they marry.** `no-mistakes axi run` blocks *"until the first approval gate, **CI-ready point**,
or final outcome"*. That **CI-ready point is precisely the release gate this project wants**: every
validating step has passed and the code is ready to ship, with the PR/CI tail — which belongs to a
workflow we do not use — skipped via `--skip`.

```bash
python3 clients/bun-crucible.py gate-run \
  --intent "0.1.0 release integrity" --agent vidushi --skip ci
```

✅ **`--skip` is live.** CR-CRU-061 §S5 shipped it on all five clients — a pure passthrough,
forwarded verbatim to `no-mistakes axi run` — so the invocation above is a real command, not an
aspiration. The skip list stays a *caller* decision: which steps a project skips is its workflow,
not a client-fleet fact, so the client never hardcodes them.

**Why route it through `gate-run` at all**, rather than calling `no-mistakes` directly: `gate-run`
proxies the run, streams throttled interim snapshots while it is in flight, and posts a **final
sealed gate event** into Crucible (CR-CRU-013). The release gate becomes evidence on the project
timeline — a `gate` event with its step ladder, findings and fix rounds — instead of a claim in a
chat log. That is the whole point of having built gate events.

**Gate:** the sealed gate's outcome must be `passed`. A `failed` outcome ends the release; fix on
`develop`, re-merge, re-run. Do not proceed on a partial pass.

### Step 4 — FULL-STACK TEST

Every test the project has, on the release branch.

Union regression (all tests except e2e) **plus** e2e, which is now meaningful — CR-CRU-060 took the
suite to 40/40 green for the first time.

- bun regression with coverage
- python regression with coverage
- `bun run test:e2e` — 40/40 expected

**Gate:** all three green. Any failure ends the release.

### Step 5 — PACKAGE, AND TEST THE PACKAGE

Build both artifacts, then test them AS ARTIFACTS — installed, not run from the source tree.

Build both artifacts and test them as artifacts, not as a source tree.

| Step | Action | Proves |
|---|---|---|
| 5.1 | `scripts/release.sh set-version 0.1.0` — **housekeeping, not the version authority** (CR-CRU-061 §S2: `publish-npm` SETS `package.json` from the tag, so a stale committed value can no longer fail a release). Kept, not retired: it keeps the committed manifest honest for the 5.3 `npm pack`, and `finish`'s first preflight still asserts it | the committed manifest agrees with the intended tag |
| 5.2 | Build the Python sdist/wheel | `crucible-axi` packages cleanly; hatch-vcs derives the version from the tag |
| 5.3 | Build/pack the npm tarball (`npm pack`) | `@anthill-tec/crucible-server` packages cleanly; the file list is what we intend to ship |
| 5.4 | **Install the built wheel into a throwaway venv** and run the client fleet's `--help` + one real verb against an ephemeral server | the packaged client works *as installed*, not just from the repo |
| 5.5 | **Verify the composite pin resolves** — the installed `crucible_axi.__version__` must select `@anthill-tec/crucible-server@0.1.0`, never `latest` | the lockstep contract holds at runtime, not just in tests |

**Gate:** 5.4 and 5.5 are the ones that matter. A wheel that builds but doesn't run is not a
release. Note 5.5 can be proven *before* the npm package exists by asserting the resolved
coordinate string, with the actual fetch deferred to Step 6.

### Step 6 — REHEARSE THE PUBLISH (throwaway targets)

The same CI path, aimed at TestPyPI and an npm dry-run. Repeatable, costs nothing, proves the real publish before it happens.

```bash
scripts/release.sh checkpoint        # dispatches release.yml → TestPyPI + npm dry-run
```

Exercises the **identical CI path** — same workflow, same jobs, same OIDC — against TestPyPI and
`npm publish --dry-run`. Repeat until clean.

**Gate:** TestPyPI upload succeeds **and** the npm dry-run succeeds. 🚨 If `NPM_TOKEN` is still
absent, `publish-npm` will *skip rather than fail* — treat a skip as a **failed gate**, not a pass
(§4).

### Step 7 — FINISH — ⚠ THE POINT OF NO RETURN

The tag push. This is the first irreversible act in the whole sequence.

```bash
scripts/release.sh finish 0.1.0
```

Preflight guards → `git flow release finish` → tag `0.1.0` (**bare SemVer, no `v`** — CR-CRU-061
§S1) → push `master` + `develop` + tags.

**This is the point of no return.** The tag push is what CI keys on.

### Step 8 — CI PUBLISHES (no human step)

```
push master → create-release → GitHub Release (published)
                                  ├─ publish-pypi  → crucible-axi → PyPI
                                  └─ publish-npm   → @anthill-tec/crucible-server → npm
```

No human step. **Watch both jobs to completion.**

### Step 9 — VERIFY FROM THE REGISTRIES

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

**RESOLVED 2026-08-03 (user).** *"GET THE tags right in the first case."* No CI guard is added.
The npm org and `NPM_TOKEN` are completed in **Phase 0 (steps 0.4)** so the skip branch can never
be reached on a release. Guarding a broken setup is the wrong fix; having the setup right is the
fix. The skip stays as-is for ordinary branch pushes, which is what it was written for.

## 5. Decisions — CLOSED

All four were settled on 2026-08-03. Recorded here because two of them **were never open**, and the
DN asked anyway.

| # | Question as posed | Resolution |
|---|---|---|
| D1 | Release version — `0.1.0` or reconcile with `2.0.0-alpha.1`? | ❌ **The question was invalid.** `2.0.0-alpha.1` is a scaffold placeholder from the repo's first commit (`eab2080`), not a published version — nothing has ever been released, so no version can "go backwards". **The version is `0.1.0`, followed by `0.2.0`**, per the storyboard. `set-version` overwrites the placeholder. |
| D2 | Repo visibility | **Public at release.** CI will not run otherwise; provenance follows for free. |
| D3 | Make the npm skip a hard failure on release tags? | **No.** Complete the org + token in Phase 0 so the skip is unreachable. Get the setup right rather than guard the wrong state. |
| D4 | Does the 0.1.0 scope still hold? | ❌ **The question was invalid.** `.lavish/crucible-v2-design.html` is the **authoritative source** for release scope and membership. It already answers this; alternatives should not have been invented against it. |

### 5.1 Standing rule this DN got wrong twice

**The storyboard (`.lavish/crucible-v2-design.html`) is authoritative for version model and release
scope.** Two of the four "decisions" above were manufactured by reading a stale scaffold default and
by offering alternatives to a question the storyboard had already settled. Check the storyboard
first; escalate only what it genuinely does not answer.

## 6. What this DN does NOT cover

- Hotfix flow — `release.sh` supports `hotfix/*`; unchanged by this DN.
- Model-B's skills bundle — theirs to release; we owe one intimation, not a coordinated release.
- 0.2.0 scope.
