# Releasing Crucible

Crucible ships **two artifacts from one repository**, in lockstep:

| Artifact | Registry | Package | Version authority |
|----------|----------|---------|-------------------|
| Python orchestrator + client fleet | PyPI | `crucible-axi` | **Derived** from the git tag by hatch-vcs |
| Bun/TS server | npm | `@anthill-tec/crucible-server` | **Manual manifest** — the literal `version` in `package.json` |

One `vX.Y.Z` tag publishes both at `X.Y.Z`. There is no way to release one without the
other, and that is deliberate — see [Composite / lockstep model](#composite--lockstep-model).

Everything below assumes the [one-time setup](#one-time-setup) has already been done on
your clone and in the GitHub repository settings.

---

## Release at a glance

Run from the `release/X.Y.Z` (or `hotfix/X.Y.Z`) branch — `scripts/release.sh` refuses to
run anywhere else:

```bash
scripts/release.sh checkpoint            # optional: TestPyPI rehearsal, repeat as needed
scripts/release.sh set-version X.Y.Z     # bump the manual manifest (package.json), commit
scripts/release.sh finish     X.Y.Z      # preflight guards -> git flow finish -> tag vX.Y.Z
                                         # -> push master + develop + tags
```

The push to `master` is what starts CI:

```
push master  ->  create-release  ->  GitHub Release (published)
                                        |-> publish-pypi   (crucible-axi   -> PyPI)
                                        `-> publish-npm    (@anthill-tec/crucible-server -> npm)
```

The rest of this document explains each step and why it is shaped that way.

---

## Version model: the tag is the version

The git tag is **`vX.Y.Z`** (e.g. `v0.1.0`). hatch-vcs strips the leading `v`, so the
version published to PyPI is exactly `X.Y.Z`.

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

The npm side is the opposite: `package.json` carries a literal version string, which is
why `scripts/release.sh set-version` exists and why `finish` refuses to proceed when the
manifest and the requested version disagree.

The `v` prefix is not cosmetic. Every publish job in `.github/workflows/release.yml`
guards on `^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$` (and additionally requires the tagged
commit to be an ancestor of `origin/master`). A tag cut without the `v` is silently
ignored by every publish job — after the merge has already happened. This is the same tag
scheme Sandesh uses, so the two repositories tally.

---

## One-time setup

### Per clone: the git-flow tag prefix

```bash
git config gitflow.prefix.versiontag v
```

`gitflow.prefix.versiontag` lives in `.git/config`, which is **not version-controlled** —
no committed file can guarantee it, so every fresh clone that will cut a release must set
it. With the prefix unset (Crucible's default), `git flow release finish` would cut a bare
`0.1.0` tag that every publish guard then rejects.

`scripts/release.sh finish` preflight-asserts this config and refuses (non-zero) when it
is not `v`, naming the fix above in its error message.

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
| `pypi` | `publish-pypi` | **Required reviewer** — this is the human gate on every production release |
| `testpypi` | `publish-testpypi` | none (rehearsal only) |
| `npm` | `publish-npm` | optional; add a required reviewer if you want npm gated too |

The required reviewer on `pypi` is the one place a release pauses for a human. Nothing is
published to PyPI until it is approved.

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
PyPI's: a trusted publisher can only be attached to a package that already exists. So the
very first publish of the scoped package `@anthill-tec/crucible-server` needs a classic
automation token, stored as the repository secret `NPM_TOKEN`.

`publish-npm` detects the token and **skips the npm publish (with a notice) when it is
absent** — PyPI is unaffected, so a release can legitimately ship Python-only until the
token is configured.

After the first successful npm publish, configure the trusted publisher on npmjs.com
(repository + `release.yml` + the `npm` environment), then delete the `NPM_TOKEN` secret
and switch the publish step to OIDC. The workflow already upgrades npm to >= 11.5.1, the
minimum version with OIDC trusted-publishing support.

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

**1. Bump the manual manifest.**

```bash
scripts/release.sh set-version X.Y.Z
```

Format-preservingly rewrites `package.json`'s `version` and commits it. The Python version
is untouched — it is tag-derived.

**2. Rehearse** (see above) — `scripts/release.sh checkpoint` — until you are happy.

**3. Finish.**

```bash
scripts/release.sh finish X.Y.Z
```

Two preflight guards run first, and either one aborts before any merge happens:

| Guard | Failure | Remedy |
|-------|---------|--------|
| Manual manifest | `package.json` version != `X.Y.Z` | `scripts/release.sh set-version X.Y.Z` |
| Tag prefix | `gitflow.prefix.versiontag` != `v` | `git config gitflow.prefix.versiontag v` |

Only then does it run `git flow <release\|hotfix> finish -m "Release X.Y.Z" X.Y.Z` (the
`-m` keeps the annotated-tag editor from hanging a non-interactive run) and
`git push origin master develop --tags`.

Add `--dry-run` to any subcommand to see what it would do, or `--verbose` for the
underlying commands.

**4. Approve the release in CI.** The push to `master` drives:

1. `create-release` — gated on `github.event_name == 'push' && github.ref == 'refs/heads/master'`. It looks for a `v[0-9]+.[0-9]+.[0-9]+` tag at `HEAD` and creates the GitHub Release for it (idempotent — a re-run on an existing Release is a no-op). Using `RELEASE_PAT` here is what makes the next step happen at all.
2. `release: published` fires, triggering the two publish jobs.
3. `publish-pypi` — pauses on the `pypi` environment for its required reviewer, re-verifies the tag ref and the `origin/master` ancestry, then uploads to PyPI via OIDC.
4. `publish-npm` — same guards, plus a check that the tag (with the `v` stripped) equals `package.json`'s version, then publishes the server package.

If a publish job is skipped, it is almost always a guard: a tag without the `v`, a tag on a
commit that is not an ancestor of `origin/master`, or a missing `NPM_TOKEN`.

---

## Composite / lockstep model

`crucible-axi` (PyPI) and `@anthill-tec/crucible-server` (npm) are released **in
lockstep** from one tag at one version. Their version authorities differ — the Python
version is **derived** by hatch-vcs from the tag; the npm version comes from the **manual
manifest**, `package.json`, bumped by `set-version` and checked twice (by the `finish`
preflight, and again at publish time against the tag).

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
