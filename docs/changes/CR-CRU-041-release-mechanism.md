# CR-CRU-041 — Release mechanism: branch-gated driver + publishable server package

**Status:** COMPLETED — merged `3ac8d6e` (2026-07-28)
**Type:** feature (release engineering)
**Priority:** P1 — 0.1.0 cannot be cut: the auto-release chain does not fire and the npm arm cannot publish
**Depends on:** CR-CRU-009 (built `pyproject.toml`, `release.yml`, the `crucible-axi` package + server `bin` shim)
**Labels:** release, packaging, ci, git-flow, npm, pypi
**Phase:** Wave 4 (0.1.0 blocker)
**Design reference:** the Sandesh release pipeline (`sandesh/RELEASING.md`,
`scripts/release.sh` per CR-SAN-034, `publish-pypi.yml` + `publish-npm.yml`) — the proven
two-registry shape carrying a tag-derived Python package plus a hand-versioned JS manifest.
Two-registry staged delegation confirmed by the user 2026-07-27 over the single-artifact
compiled alternative.

## Context
CR-CRU-009 built the release machinery — `pyproject.toml` (hatchling + hatch-vcs,
`local_scheme = "no-local-version"`), a consolidated `.github/workflows/release.yml`
modelled on Sandesh's two workflows, the `crucible-axi` package, and the
`bin/crucible-server.mjs` shim. git-flow is initialised with an EMPTY
`gitflow.prefix.versiontag`, so tags are bare `X.Y.Z` and the workflow's guards already
match that scheme.

Four defects block an actual release:

1. **The auto-release chain does not exist.** `release.yml`'s `on:` block has NO `push:`
   trigger, and `create-release` is gated `if: github.event_name == 'workflow_dispatch'`.
   Pushing `master` carrying the version tag fires nothing. Worse, `create-release`,
   `publish-testpypi` and `dry-run-npm` are ALL gated on `workflow_dispatch`, so the one
   dispatch that would create the Release also fires a Test-PyPI upload.
2. **The npm arm cannot publish.** `package.json` is `"private": true` (npm refuses to
   publish), the name is unscoped `crucible`, there is no `files`/`publishConfig`, and
   `crucible_axi/install.py:30` still reads
   `SERVER_NPM_PACKAGE = "crucible-server"  # TODO(S4): real published npm package name`.
3. **The version guard sits on the wrong side of the tag.** `publish-npm` checks
   `package.json` version == tag, but that runs AFTER the tag is cut, the Release created,
   and PyPI possibly already published — leaving a half-released state. Sandesh moved this
   guard left into `release.sh finish`; its 0.3.1 → 0.3.2 version-sync hotfix exists
   precisely to make that unnecessary.
4. **No release driver and no written procedure** — no `scripts/release.sh`, no
   `RELEASING.md`, so no rehearsal path and no recorded prerequisites.

## Scope

### §S1 — Make the server package publishable
In `package.json`: remove `"private": true`; rename `crucible` →
**`@anthill-tec/crucible-server`**; add `publishConfig.access = "public"`; add a `files`
whitelist shipping only what the server needs to run (`bin/`, `src/`, `public/`) and
excluding repo working state (`tests/`, `data/`, `crucible.db`, `coverage/`,
`test-reports/`, `test-results/`, `.features-gen/`). Resolve
`crucible_axi/install.py`'s `SERVER_NPM_PACKAGE` to the published name, retiring the
`TODO(S4)`.

### §S2 — Repair the `release.yml` trigger topology
Add `on: push: branches: [develop, master]` and `on: pull_request`, so `build` runs
continuously and packaging breakage surfaces on PRs rather than on release day. Re-gate
`create-release` to `github.event_name == 'push' && github.ref == 'refs/heads/master'`
(the Sandesh chain: push master carrying a version tag → Release → guarded publish).
`workflow_dispatch` is then reserved for rehearsal only (Test-PyPI + npm dry-run),
resolving the three-way dispatch collision.

### §S3 — `scripts/release.sh` — branch-gated release driver
A driver allowed ONLY on `release/*` or `hotfix/*` branches, with `--dry-run`,
`--verbose`, `-h/--help`, and subcommands:
- `set-version <X.Y.Z>` — rewrite + commit the **manual manifest**, `package.json`
  (format-preserving; the Python version stays hatch-vcs tag-derived and is never
  hand-edited).
- `checkpoint` — `gh workflow run release.yml --ref <branch>` for the Test-PyPI rehearsal.
- `finish <X.Y.Z>` — **preflight manifest guard first**: refuse (non-zero) if
  `package.json` version != `X.Y.Z`, instructing the operator to run `set-version`. Then
  `git flow <release|hotfix> finish` (with `-m` so the annotated-tag editor cannot hang a
  non-interactive run) and `git push origin master develop --tags`.
- `status` — current branch + tag-derived version.

### §S4 — `RELEASING.md`
Document: the tag-driven version model (bare `X.Y.Z`, hatch-vcs, no hand-edited Python
version); the one-time prerequisites (PyPI + TestPyPI **pending** Trusted Publishers; the
`pypi` / `testpypi` / `npm` GitHub Environments, with a required reviewer on `pypi` as the
human gate; `RELEASE_PAT`, needed because a Release created with the default `GITHUB_TOKEN`
does not re-fire `on: release`; `NPM_TOKEN` for the inaugural scoped publish, since npm has
no pending-publisher equivalent, then the flip to OIDC); the TestPyPI rehearsal loop; and
the `set-version` → `finish` → push-master → publish order.

### §S5 — Adopt Sandesh's `vX.Y.Z` tag scheme (REVISED 2026-07-28, user decision)
Crucible must tally with Sandesh: the git tag is **`vX.Y.Z`**, and hatch-vcs strips the `v`
so the published PyPI version is exactly `X.Y.Z`. Sandesh runs
`gitflow.prefix.versiontag = v` with tags `v0.3.0`…`v0.3.5`; Crucible's prefix is currently
**empty**, so `git flow release finish` would cut a bare `0.1.0`. **Crucible has no tags
yet**, so this is a free change now and an expensive one after the first release.

- `publish-pypi` and `publish-npm` guards: `^refs/tags/[0-9]+\.[0-9]+\.[0-9]+$` →
  `^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$`.
- `create-release` tag detection: `grep -E '^[0-9]+\.[0-9]+\.[0-9]+$'` →
  `'^v[0-9]+\.[0-9]+\.[0-9]+$'`.
- **KEEP** `publish-npm`'s `VERSION="${GITHUB_REF_NAME#v}"` — under this scheme it is
  correct and load-bearing (it derives the bare version the `package.json` comparison
  needs). The earlier "drop the vestigial strip" item is **withdrawn**.
- `gitflow.prefix.versiontag` lives in `.git/config`, which is **not version-controlled**,
  so it cannot be fixed by a committed file. `release.sh finish` therefore **preflight-
  asserts** `git config --get gitflow.prefix.versiontag` equals `v` and refuses otherwise,
  naming the one-time `git config gitflow.prefix.versiontag v` fix; `RELEASING.md` lists it
  as a clone-setup prerequisite. (Sandesh depends on this config silently; asserting it is
  a deliberate improvement — an unset prefix would otherwise cut a tag that every publish
  guard then rejects, after the merge has already happened.)
- CR-CRU-009 §S6's "tag `0.1.0`" is superseded: the 0.1.0 tag is **`v0.1.0`**.

### §S6 — Composite release strategy: one repo, two artifacts, ONE version
Crucible ships a **Python** orchestrator + client fleet (`crucible-axi`, PyPI) and a
**Bun/TS** server (`@anthill-tec/crucible-server`, npm) from a single repo. They release in
**lockstep**: one `vX.Y.Z` tag publishes both at `X.Y.Z`. This mirrors Sandesh
(`sandesh-relay` on PyPI + `@anthill-tec/sandesh-pi` on npm, both pinned to the same tag).

Version authority per artifact:
- **Python — DERIVED.** hatch-vcs reads the tag; `pyproject.toml` has no version field and
  is never hand-edited.
- **npm — MANUAL MANIFEST.** `package.json` carries a literal version, bumped by
  `release.sh set-version` (§S3) and guarded pre-tag by `finish` (§S3) and again at publish
  time by the CI tag-vs-`package.json` check.

**Version-pin the cross-artifact fetch.** The two are not merely co-released — the Python
side FETCHES the npm side at install time, so lockstep must be enforced at runtime, not
just at publish. Currently `crucible_axi/install.py` runs
`subprocess.run(["npx", "-y", SERVER_NPM_PACKAGE])` with **no version**, which resolves to
`latest`: a pinned `crucible-axi X.Y.Z` would pull whatever server is newest. Fix:
- Expose `crucible_axi.__version__` via `importlib.metadata.version("crucible-axi")`.
- The `[server]` stage fetches `<SERVER_NPM_PACKAGE>@<that version>`, so the orchestrator
  always provisions the server it was released with.
- Provide one documented escape hatch (`CRUCIBLE_SERVER_VERSION`) for development and for
  recovering from a bad server publish; unset means the pinned version, never `latest`.

(This is a difference from Sandesh worth naming: its Pi extension does not bundle or fetch
sandesh-core — it shells to whatever `sandesh` CLI is on PATH. Crucible's Python side
actively provisions its server, so the pin carries weight there that it does not there.)

## Acceptance criteria
- [ ] `npm pack --dry-run` on the server package emits a tarball whose file list contains
      `bin/`, `src/`, `public/` and contains NONE of `tests/`, `data/`, `crucible.db`,
      `coverage/`, `test-reports/`, `test-results/` — asserted by a test, not by eye.
- [ ] `package.json` has no `private` field, `name == "@anthill-tec/crucible-server"`, and
      `publishConfig.access == "public"`.
- [ ] `grep -c 'TODO(S4)' crucible_axi/install.py` is 0 and `SERVER_NPM_PACKAGE` equals the
      `package.json` name — asserted, so the two cannot drift.
- [ ] `release.sh set-version 9.9.9` on a `release/*` branch sets `package.json` to `9.9.9`
      and commits; on `develop` it exits 2 without writing.
- [ ] `release.sh finish 9.9.9` **refuses with non-zero** when `package.json` is any other
      version, naming `set-version` in the error — the guard fires BEFORE any git-flow or
      push command runs (verified via `--dry-run` as a true preflight).
- [ ] `release.sh checkpoint` and `finish` both exit 2 on a non-`release/*`/`hotfix/*`
      branch.
- [ ] `release.yml` parses as valid workflow YAML; `create-release` is gated on
      push-to-master; `build` has `pull_request` and `push` triggers; no job other than
      `publish-testpypi` and the npm dry-run is reachable from `workflow_dispatch`.
- [ ] `RELEASING.md` exists and names every prerequisite in §S4, including the one-time
      `git config gitflow.prefix.versiontag v`.
- [ ] **Tag scheme (§S5):** both publish guards and the `create-release` tag detection match
      `v`-prefixed tags only — a bare `0.1.0` tag is REJECTED by the guard, and `v0.1.0` is
      accepted — asserted against the workflow text.
- [ ] **Tag-prefix preflight (§S5):** `release.sh finish` exits non-zero when
      `gitflow.prefix.versiontag` is unset or not `v`, naming the fix, before any git-flow
      or push command runs.
- [ ] **Composite pin (§S6):** `crucible_axi.__version__` resolves via
      `importlib.metadata`, and the `[server]` stage's npx argv contains
      `<pkg>@<__version__>` — never a bare package name — asserted on the invoked command.
- [ ] **Composite escape hatch (§S6):** `CRUCIBLE_SERVER_VERSION` overrides the pin; unset
      yields the pinned version and never `latest` — asserted.

## Non-goals
- **Running the release.** Cutting the branch, tagging `0.1.0`, and publishing remain a
  separate human-gated phase (CR-CRU-009 §S6) requiring its own explicit go.
- Creating the npm org / PyPI publishers / GitHub Environments / secrets — owner actions on
  external services, documented in §S4 but performed by the user. Tests mock or dry-run all
  registry interaction, per CR-CRU-009's implementation notes.
- Open-sourcing the repo (LICENSE + public flip) — a human-gated release prerequisite.
- The single-artifact compiled fusion (`bun build --compile` into platform wheels) — the
  user selected two-registry staged delegation for 0.1.0; the compiled path stays a
  post-0.1.0 option and would also close CR-CRU-009's noted air-gap follow-up.

## Risk
- **npm org prerequisite:** `@anthill-tec` does not exist yet (user confirmed 2026-07-28).
  The scoped publish cannot succeed until it is created and `NPM_TOKEN` is set. This blocks
  the RELEASE, not this CR — but a PyPI-only 0.1.0 would ship a `crucible-axi` whose
  `[server]` stage has nothing to fetch, so the org is a hard precondition for a meaningful
  release.
- The existing "skip npm publish when `NPM_TOKEN` is absent" branch keeps CI green while the
  org is pending; it must not be mistaken for a successful npm release.
