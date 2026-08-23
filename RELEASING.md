# Releasing Crucible

Crucible ships **two artifacts from one repository**, in lockstep:

| Artifact | Registry | Package | Version authority |
|----------|----------|---------|-------------------|
| Python orchestrator + client fleet | PyPI | `crucible-axi` | **Derived** from the git tag by hatch-vcs |
| Bun/TS server | npm | `@anthill-tec/crucible-server` | **Derived** from the git tag — `publish-npm` sets `package.json`'s `version` from the tag at publish time |

One bare-SemVer `X.Y.Z` tag publishes both at `X.Y.Z`. **The tag is the single version
authority for both artifacts**, and nothing is hand-versioned. There is no way to release
one without the other, and that is deliberate — see
[Composite / lockstep model](#composite--lockstep-model).

Tags carry **no `v` prefix**. If you are looking for the older `v`-prefixed scheme, see
[Superseded: the v-prefixed tag scheme](#superseded-the-v-prefixed-tag-scheme).

Everything below assumes the [one-time setup](#one-time-setup) has already been done on
your clone and in the GitHub repository settings.

---

## Release at a glance

Run from the `release/X.Y.Z` (or `hotfix/X.Y.Z`) branch — `scripts/release.sh` refuses to
run anywhere else:

```bash
scripts/release.sh checkpoint            # optional: TestPyPI rehearsal, repeat as needed
scripts/release.sh set-version X.Y.Z     # housekeeping: align the committed package.json,
                                         # commit. NOT the version authority (see below)
scripts/release.sh finish     X.Y.Z      # preflight guards -> git flow finish -> tag X.Y.Z
                                         # (bare, no `v`) -> push master + develop + tags
```

**On `set-version`.** It no longer decides what npm publishes — `publish-npm` sets
`package.json`'s version from the tag, so a stale committed value cannot affect or fail a
release. It is **kept** for two narrower reasons: it keeps the committed manifest honest
for local builds and `npm pack` rehearsals, and `finish`'s first preflight still asserts
the committed manifest equals the finish version. So run it before `finish` (or that
preflight refuses), but understand it as housekeeping, not as the step that sets the
released version.

The push to `master` is what starts CI:

```
push master  ->  create-release  ->  GitHub Release (published)
                                        |-> publish-pypi   (crucible-axi   -> PyPI)
                                        `-> publish-npm    (@anthill-tec/crucible-server -> npm)
```

The rest of this document explains each step and why it is shaped that way.

---

## Version model: the tag is the version

The git tag is **bare SemVer — `X.Y.Z`** (e.g. `0.1.0`), with **no prefix of any kind**.
hatch-vcs derives from it directly, so the version published to PyPI is exactly `X.Y.Z`.

`pyproject.toml` declares:

```toml
[project]
dynamic = ["version"]

[tool.hatch.version]
source = "vcs"
raw-options = { local_scheme = "no-local-version" }
```

There is **no `version = "..."` field** in `pyproject.toml`, and the Python version must
**never be hand-edited** anywhere. You bump the Python version by tagging — nothing else.

**The npm side now works the same way.** `package.json` still carries a literal `version`
field (npm has no dynamic equivalent), but that committed value is **not consulted at
publish time**. `publish-npm` runs

```bash
npm version --no-git-tag-version --allow-same-version "$VERSION"   # $VERSION = the tag
```

which **sets** the manifest from the tag in the CI workspace (never committed back), and
then publishes. A stale committed version can no longer fail a release, and there is no
version that can disagree with the tag.

That leaves `scripts/release.sh set-version` **redundant as a version authority**. It is
deliberately kept, not retired, for exactly two jobs — keeping the committed manifest
honest for local builds/`npm pack`, and satisfying `finish`'s manifest preflight — and it
must not be presented as the step that decides the released version. See
[Release at a glance](#release-at-a-glance).

The tag format is not cosmetic. Every publish job in `.github/workflows/release.yml`
guards on `^refs/tags/[0-9]+\.[0-9]+\.[0-9]+$` (and additionally requires the tagged
commit to be an ancestor of `origin/master`), and `create-release` discovers the tag at
`HEAD` with the matching `^[0-9]+\.[0-9]+\.[0-9]+$`. A prefixed tag is **rejected** by
every publish job — after the merge has already happened. The guards accept exactly one
format on purpose; loosening them to tolerate both would reintroduce the two-format drift
they exist to prevent.

---

## One-time setup

### Per clone: the git-flow tag prefix

```bash
git config gitflow.prefix.versiontag ""
```

`gitflow.prefix.versiontag` lives in `.git/config`, which is **not version-controlled** —
no committed file can guarantee it, so every fresh clone that will cut a release must set
it.

🚨 **Set-to-empty is not the same as unset, and only set-to-empty works.** This was
measured, not assumed: with the key *unset*, git-flow itself aborts with
`Fatal: Version tag not set` and cuts nothing; with the key *present and empty*, it cuts
the bare `X.Y.Z` tag the publish guards require. The quotes in the command above are
therefore load-bearing.

`scripts/release.sh finish` preflight-asserts exactly that state and refuses (non-zero)
in **both** wrong states — unset, and set to any non-empty prefix — naming the fix above
in its error message. It distinguishes the two via `git config --get`'s exit status (1 =
key absent, 0 = key present even when the value is empty).

### PyPI and TestPyPI: pending Trusted Publishers

Both projects publish via OIDC — there are no PyPI API tokens anywhere in this repo.
Because `crucible-axi` has never been published, register a **pending** Trusted Publisher
on each index (a pending publisher is the pre-first-release form; it converts to a normal
Trusted Publisher automatically on the first successful upload):

- <https://pypi.org/manage/account/publishing/>
- <https://test.pypi.org/manage/account/publishing/>

For both, use:

| Field | Value |
|-------|-------|
| PyPI project name | `crucible-axi` |
| Owner | the repository owner |
| Repository | `crucible` |
| Workflow name | `release.yml` |
| Environment | `pypi` (on PyPI) / `testpypi` (on TestPyPI) |

### GitHub Environments

Create three environments under **Settings -> Environments**, matching the `environment:`
keys in `release.yml`:

| Environment | Used by | Protection |
|-------------|---------|------------|
| `pypi` | `publish-pypi` | **Required reviewer** — the human gate on every production release |
| `testpypi` | `publish-testpypi` | none needed (rehearsal only) |
| `npm` | `publish-npm` | optional; add a required reviewer if you want npm gated too |

The required reviewer on `pypi` is the one place a release pauses for a human. Nothing is
published to PyPI until it is approved.

🚨 **Protection rules need a public repo or a paid plan.** Deployment protection rules
(required reviewers, wait timer) are available on **public** repositories, or on private
ones under Pro/Team/Enterprise. On a **free-plan private** repo the section is not
rendered at all — the environments still work and are still required (their NAMES are what
`release.yml` and PyPI's trusted-publisher config verify), but the reviewer gate is simply
unavailable and the human gate is then "you decide when to cut the tag". Measured
2026-08-13 on this repo while it was private: the setting did not exist. It was made
public, which also unblocked `npm publish --provenance` (see below).

> Note: a required reviewer on `testpypi` makes every rehearsal dispatch pause for a click.
> Leave it unprotected unless you want that.

### `RELEASE_PAT`

`create-release` creates the GitHub Release with `GH_TOKEN: ${{ secrets.RELEASE_PAT }}`,
**not** the default `GITHUB_TOKEN`. This is load-bearing: a Release created with the
default `GITHUB_TOKEN` does not re-fire `on: release` workflows. With the default token
the Release would appear and then nothing would publish — the `publish-pypi` and
`publish-npm` jobs (both gated on `github.event_name == 'release'`) would never be
triggered at all.

Create a fine-grained PAT with **Contents: read & write** on this repository and store it
as the repository secret `RELEASE_PAT`.

### `NPM_TOKEN` (inaugural publish only)

npm supports OIDC trusted publishing, but it has **no pending-publisher equivalent** to
PyPI's: a trusted publisher is attached to a package's own settings, so it cannot be
configured before the package exists. The very first publish of
`@anthill-tec/crucible-server` therefore needs a token, stored as the repository secret
`NPM_TOKEN`.

🚨 **Use a GRANULAR token — classic/legacy tokens no longer exist.** Per npm's docs, "as of
November 2025, only Granular access tokens are supported. Legacy access tokens have been
removed." Create it on the website (the CLI cannot mint granular tokens yet) with:

| Field | Value |
|-------|-------|
| Packages and scopes | **the `@anthill-tec` scope**, Read **and write** — the package does not exist yet, so it cannot be selected by name; the scope is what authorises creating it |
| Organizations | **No access** — org access only manages settings/teams and grants no publish right |
| Allowed IP ranges | **empty** — Actions runners get arbitrary IPs; any CIDR here fails the publish |
| Expiration | short (e.g. 30 days) — it only has to survive the inaugural publish |
| Bypass 2FA | see below |

**Bypass 2FA must be CHECKED on the token — regardless of the account's 2FA mode.** This was
wrong in an earlier draft and it cost a failed release-day publish (2026-08-19). Per npm's
Sept–Nov 2025 security changes, **write-enabled granular tokens enforce 2FA by default**, and the
**"Bypass two-factor authentication" option is UNCHECKED by default**. So an unchecked token is
challenged for a one-time password on `npm publish` — CI fails `EOTP` — **even when the account is
set to "authorization only"** (measured on this repo: account was authorization-only, publish still
demanded an OTP). The account mode governs interactive account actions, not the token's publish
enforcement. Fix: create the granular token with **Bypass 2FA CHECKED**. Note npm is deprecating
bypass-2FA tokens for direct publishing (`gh.io/npm-gat-bypass2fa-deprecation`), which is why the
OIDC cutover below is the real destination — a token is the inaugural-publish stopgap only.

`publish-npm` detects the token and **skips the npm publish (with a notice) when it is
absent** — PyPI is unaffected, so a release can legitimately ship Python-only until the
token is configured.

After the first successful npm publish, configure the trusted publisher on npmjs.com
(repository + `release.yml` + the `npm` environment), then delete the `NPM_TOKEN` secret
and switch the publish step to OIDC. The workflow already upgrades npm to >= 11.5.1, the
minimum version with OIDC trusted-publishing support.

**DONE 2026-08-19 (after the 0.1.1 publish):** the trusted publisher is configured
(`anthill-tec/crucible` → `release.yml`, perms `npm publish` + `npm stage publish`), and
`publish-npm` now publishes token-free via OIDC (the `NODE_AUTH_TOKEN` / `NPM_TOKEN`-detect
wiring is retired). Two remaining maintainer clicks on npmjs.com: set Publishing access to
**"Require 2FA and disallow bypass-2fa tokens"** (trusted publishers keep working under it —
npm's own note) and **delete the `NPM_TOKEN` repo secret** (no longer read by any workflow).
The `NPM_TOKEN` section above is retained as the inaugural-publish record — OIDC cannot bootstrap
a package that does not yet exist, so a first publish will always need this token path again.

### The repo must be PUBLIC for `--provenance`

`publish-npm` runs `npm publish --provenance`. Provenance attestations are recorded in
Sigstore's **public** transparency log, so the step requires a public repository — on a
private one it fails at publish time, i.e. on release day. This is easy to miss because
nothing else in the pipeline cares: the suites, the packaging and the PyPI publish are all
indifferent to visibility.

**`package.json` MUST carry a `repository` field matching this repo, or `--provenance` is
rejected.** npm verifies the signed provenance bundle against `package.json`'s `repository.url`;
if it is missing or does not normalise to `https://github.com/anthill-tec/crucible`, the publish
fails `E422 "Failed to validate repository information"` — *after* the tag is cut, on release day.
This bit the 0.1.0 cut (package.json had no `repository` field); hotfix 0.1.1 added
`{"type":"git","url":"git+https://github.com/anthill-tec/crucible.git"}`. Keep it present.

---

## TestPyPI rehearsal loop

Before cutting anything real, rehearse from the release branch:

```bash
scripts/release.sh checkpoint
```

This runs `gh workflow run release.yml --ref <current branch>` — a `workflow_dispatch`,
which is **rehearsal-only**: it triggers `publish-testpypi` and `dry-run-npm` (an
`npm pack --dry-run` that shows the exact tarball file list) and nothing else.
`create-release`, `publish-pypi` and `publish-npm` are all gated off for a dispatch, so a
checkpoint can never publish to production.

Repeat it as often as you like. Each checkpoint uploads a fresh dev build, so you see the
real sdist/wheel, the real metadata, and the real install path before committing to a tag.

**Why an untagged branch is uploadable.** PyPI and TestPyPI both reject PEP 440 local
versions (anything with a `+` segment), and hatch-vcs's default `local_scheme` produces
exactly that on an untagged commit (`0.1.0.dev3+g1a2b3c4`). `pyproject.toml` sets
`local_scheme = "no-local-version"`, so an untagged commit derives a clean, uploadable
`X.Y.Z.devN` instead — which is what makes a rehearsal possible with no release-candidate
tag and no throwaway tags polluting the history. `publish-testpypi` still asserts the
absence of a `+` segment before uploading, as a backstop.

---

## Cutting a release

Start the branch the usual git-flow way from `develop` (the integration branch):

```bash
git flow release start X.Y.Z      # or: git flow hotfix start X.Y.Z
```

Then, on that branch:

**1. Align the committed manifest** (housekeeping, and `finish`'s first preflight).

```bash
scripts/release.sh set-version X.Y.Z
```

Format-preservingly rewrites `package.json`'s `version` and commits it. Neither published
version comes from here — the Python version is hatch-vcs tag-derived, and the npm version
is set from the tag by `publish-npm`. This keeps the committed manifest consistent with the
tag you are about to cut (and gets `finish`'s manifest preflight out of the way).

**2. Rehearse** (see above) — `scripts/release.sh checkpoint` — until you are happy.

**3. Finish.**

```bash
scripts/release.sh finish X.Y.Z
```

Two preflight guards run first, and either one aborts before any merge happens:

| Guard | Failure | Remedy |
|-------|---------|--------|
| Committed manifest | `package.json` version != `X.Y.Z` | `scripts/release.sh set-version X.Y.Z` |
| Tag prefix | `gitflow.prefix.versiontag` is unset, or set to a non-empty prefix | `git config gitflow.prefix.versiontag ""` |

The manifest guard is now a *consistency* check, not a correctness one: even if it were
bypassed, `publish-npm` would still publish at the tag's version.

Only then does it run `git flow <release\|hotfix> finish -m "Release X.Y.Z" X.Y.Z` (the
`-m` keeps the annotated-tag editor from hanging a non-interactive run) and
`git push origin master develop --tags`.

Add `--dry-run` to any subcommand to see what it would do, or `--verbose` for the
underlying commands.

**4. Approve the release in CI.** The push to `master` drives:

1. `create-release` — gated on `github.event_name == 'push' && github.ref == 'refs/heads/master'`. It looks for a `[0-9]+.[0-9]+.[0-9]+` tag at `HEAD` and creates the GitHub Release for it (idempotent — a re-run on an existing Release is a no-op). Using `RELEASE_PAT` here is what makes the next step happen at all.
2. `release: published` fires, triggering the two publish jobs.
3. `publish-pypi` — pauses on the `pypi` environment for its required reviewer, re-verifies the tag ref and the `origin/master` ancestry, then uploads to PyPI via OIDC.
4. `publish-npm` — same guards, then **sets** `package.json`'s version from the tag (`npm version --no-git-tag-version --allow-same-version "$VERSION"`, workspace-only, never committed back) and publishes the server package. There is no version to disagree about, so there is no version check.

If a publish job is skipped, it is almost always a guard: a prefixed or malformed tag, a
tag on a commit that is not an ancestor of `origin/master`, or a missing `NPM_TOKEN`.

---

## Composite / lockstep model

`crucible-axi` (PyPI) and `@anthill-tec/crucible-server` (npm) are released **in
lockstep** from one tag at one version. Both version authorities are now the same one: the
tag. The Python version is **derived** by hatch-vcs from the tag; the npm version is
**derived** from the same tag by `publish-npm`, which sets `package.json` from it at
publish time. Neither is hand-versioned, and there is no second source that could drift.

Lockstep is enforced at runtime too, not just at publish time. `crucible-axi` installs the
server by fetching it from npm, and it **pins that fetch to its own version**:
`crucible_axi.__version__` (resolved via `importlib.metadata`) selects
`@anthill-tec/crucible-server@<that version>`. A pinned `crucible-axi X.Y.Z` therefore
always provisions the server it was released with, never `latest`.

The one escape hatch is the `CRUCIBLE_SERVER_VERSION` environment variable, which
overrides the pin — for local development, or to recover from a bad server publish without
re-releasing the Python side. Unset means the pinned version; it never falls back to
`latest`.

Practical consequence: **do not** publish one artifact alone. If a publish job fails after
the other succeeded, fix forward with a new patch release rather than hand-publishing the
straggler at a version no tag corresponds to.

---

## Superseded: the v-prefixed tag scheme

⚠️ **This section is history, not instructions.** Everything in it was replaced by
CR-CRU-061 and is recorded only so a reader who finds the old shape in a commit, a comment
or an older doc can see that the scheme changed, and why. Do not follow it.

**What CR-CRU-041 §S5 specified.** Tags were `vX.Y.Z` (e.g. `v0.1.0`). hatch-vcs stripped
the leading `v`, so PyPI still saw `X.Y.Z`. Every publish guard matched
`^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$`, `create-release` discovered a `v[0-9]+.[0-9]+.[0-9]+`
tag at `HEAD`, `publish-npm` compared the tag *with the `v` stripped* (`${GITHUB_REF_NAME#v}`)
against `package.json`, and every clone had to run `git config gitflow.prefix.versiontag v`.
The rationale was tallying with Sandesh, which uses the same `v`-prefixed scheme.

**Why it was replaced (CR-CRU-061, 2026-08-03).**

- **The `v` prefix was dropped by user ruling** — tags are bare SemVer, `0.1.0`. §S1 moved
  all six live prefix sites to `^[0-9]+\.[0-9]+\.[0-9]+$` and removed the now-dead `#v`
  strips rather than leaving them as decoration, since a strip that can never match is a
  lie about the format. The divergence from Sandesh (which keeps `v`) is accepted, not a
  defect to chase.
- **The manual-manifest model was dropped too** — §S2 made `publish-npm` *set*
  `package.json` from the tag instead of verifying it, so the tag is the single version
  authority for both artifacts and a stale committed version can no longer fail a release.
  `release.sh set-version` survives as housekeeping only.
- **The git-flow config flipped from `v` to set-and-empty** — and the *unset* state, which
  the old scheme treated as merely "the default", turns out to be a hard failure of
  git-flow itself. `release.sh` therefore refuses unset as well as any non-empty prefix.

The current, authoritative model is
[Version model: the tag is the version](#version-model-the-tag-is-the-version).
