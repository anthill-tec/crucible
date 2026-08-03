# CR-CRU-061 — Bare-SemVer tags, and the npm version DERIVED from the tag instead of hand-bumped

**Status:** PENDING
**Type:** patch (release machinery)
**Priority:** P0 — blocks the 0.1.0 release; the tag format must be settled before the first tag exists
**Depends on:** CR-CRU-041 (release mechanism: `release.sh`, `release.yml`, composite lockstep)
**Labels:** patch, release, ci, packaging, versioning
**Phase:** Wave 4
**Design reference:** `docs/research/DN-release-process.md`; `RELEASING.md` §"Version model: the tag is
the version"

## Context

Two user decisions, 2026-08-03, that the current machinery does not implement:

1. **Tags are bare SemVer — `0.1.0`, not `v0.1.0`.**
2. **Packaging must take the version from the GitHub tag automatically**, so setting a tag is all a
   release needs.

**On (2), the two halves are not in the same state — measured:**

| Artifact | Version source today | Automatic from tag? |
|---|---|---|
| `crucible-axi` (PyPI) | `dynamic = ["version"]` + **hatch-vcs** (`pyproject.toml:7,32`) | ✅ **already** derived from the tag |
| `@anthill-tec/crucible-server` (npm) | **hand-bumped `package.json`**, then CI *verifies* it equals the tag (`release.yml:156-165`) | ❌ manual — CI checks agreement, never sets it |

So the Python side already does exactly what the user asked. The npm side inverts it: a human runs
`release.sh set-version X.Y.Z`, and CI's only job is to **refuse** if they got it wrong. That is a
guard around a manual step that should not exist.

**On (1), the `v` prefix is hardcoded in six live places** — this is why it is a CR and not a
`git config`:

| Site | What it does | Effect of a bare tag |
|---|---|---|
| `scripts/release.sh:172-176` | `guard_tag_prefix()` hard-asserts `gitflow.prefix.versiontag == "v"` | **hard ERROR**, release cannot start |
| `.github/workflows/release.yml:59` | `git tag --points-at HEAD \| grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'` | finds **no tag** → `create-release` produces nothing |
| `.github/workflows/release.yml:83-84` | `publish-pypi` guard `^refs/tags/v[0-9]+…` | **refuses to publish** |
| `.github/workflows/release.yml:147-148` | `publish-npm` guard `^refs/tags/v[0-9]+…` | **refuses to publish** |
| `scripts/release.sh:296` | `version="${version#v}"` | harmless, but dead code |
| `.github/workflows/release.yml:160` | `VERSION="${GITHUB_REF_NAME#v}"` | harmless, but dead code |

Also: `git config gitflow.prefix.versiontag` was briefly set to `v` by the orchestrator on
2026-08-03 while clearing release pre-flight, and has been **unset again** — the correct value under
this CR is the empty string, and `release.sh` must assert THAT.

**Why this must land before the release, not after.** No tag exists yet (`git tag -l` → 0, remote
included). The tag format is therefore still free. Once `0.1.0` is cut in either format it is
published history on two registries, and changing it later means a version that exists in one shape
on npm and another in git.

## Scope

### §S1 — Bare-SemVer tags end to end
Retire the `v` prefix across the six sites above.
- `release.sh`'s `guard_tag_prefix()` must assert `gitflow.prefix.versiontag` is **empty**, and its
  error text must give the exact fix command for that value.
- Both CI publish guards and the `create-release` tag discovery must match `^[0-9]+\.[0-9]+\.[0-9]+$`.
- Remove the now-dead `#v` strips rather than leaving them as decoration — a stripped prefix that
  can never be present is a lie about the format.

Keep the guards **strict**. They exist so a malformed or hand-cut tag cannot reach a publish job;
loosening them to accept both forms would defeat the point and permit exactly the two-format drift
this CR prevents.

### §S2 — Derive the npm version from the tag
`publish-npm` must **set** `package.json`'s version from the tag at publish time (e.g. `npm version
--no-git-tag-version --allow-same-version "$VERSION"`), replacing the verify-only step. The tag
becomes the single version authority for both artifacts, matching hatch-vcs on the Python side.

Consequence to handle deliberately: `release.sh set-version` becomes **redundant** for the release
path. Decide and record whether it is retired or kept as a convenience for local builds — do not
leave it in `RELEASING.md`'s "Release at a glance" as a required step it no longer is.

### §S3 — The lockstep pin must still resolve
`crucible_axi.__version__` selects `@anthill-tec/crucible-server@<that version>`
(`tests/client/test_crucible_axi_version_pin.py`, 10 tests). Both sides now derive from the same
tag, which should make the pin *more* robust — but the pin's tests encode assumptions about version
strings and must be re-run and, if they assume a `v`, corrected.

### §S4 — Documentation matches the machinery
`RELEASING.md` documents the `v` model and the manual-manifest model in several places (§"Version
model", §"Release at a glance", §"Composite / lockstep model"). Update it, and the release DN, so no
reader is told to do a step that no longer exists.

## Acceptance criteria
- [ ] `release.sh`'s tag-prefix guard asserts an EMPTY prefix and its error message names the exact
      fix — asserted.
- [ ] `create-release` discovers a bare `X.Y.Z` tag — asserted.
- [ ] Both publish guards accept `refs/tags/X.Y.Z` and **reject** `refs/tags/vX.Y.Z` and any
      malformed tag — asserted for both the accept and the reject case.
- [ ] `publish-npm` SETS `package.json`'s version from the tag; a stale committed value no longer
      fails the release — asserted, including that the published version equals the tag.
- [ ] No `#v` strip or `^v` pattern survives in `release.sh` or `release.yml` — asserted by sweep.
- [ ] The composite pin still resolves `crucible-axi X.Y.Z` → `@anthill-tec/crucible-server@X.Y.Z`;
      all 10 pin tests green.
- [ ] `RELEASING.md` and `DN-release-process.md` describe the bare-SemVer, tag-derived model, with no
      surviving instruction to hand-bump `package.json` — asserted.
- [ ] Full bun regression green AND full Python regression green.

## Non-goals
- Changing the composite lockstep MODEL (CR-CRU-041) — only its version source.
- Changing what gets published, or the OIDC/Trusted-Publishing setup.
- The `CRUCIBLE_SERVER_VERSION` escape hatch — unchanged.
- Retiring `release.sh` itself. Its branch gating and preflights stay valuable; only the version
  step is in question (§S2).

## Risk
- **The CI guards cannot be exercised locally.** They run only on a tag push, and a wrong guard is
  discovered at the moment of publishing. Prefer testing the guard *expressions* directly (extract
  and unit-test the regex/inputs) over trusting a read of the YAML — a workflow that "looks right"
  is how the current `v` assumption survived unnoticed into a release plan.
- **This CR changes the thing that publishes.** A mistake here is not caught by the test suite; it
  surfaces as a failed or — worse — a *half-completed* publish. The npm/PyPI lockstep rule
  (*"do not publish one artifact alone"*) makes a partial failure expensive to unwind.
- **`npm version` rewrites `package.json` in the CI workspace.** Confirm it does not get committed
  back, and that `--allow-same-version` prevents a spurious failure when the value already matches.
