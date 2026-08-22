# CR-CRU-084 — a release records the package(s) it delivered

- **Type**: feature
- **Wave**: 5
- **Depends on**: 080
- **Status**: PENDING

## Problem

Per `docs/research/DN-crucible-wave-track-release.md`, a release is a milestone carrying **a release
version AND a package or packages of the software developed so far**, and it **always results in a
package being released to the users**. The package is not incidental — it is what makes a release a
release, and it is the terminal end of the Model-B chain: CR specs → source code → **release
packages**.

Crucible records only half of that. A release today carries `version`, `commit`, `releasedAt` and
`crs`; there is **no package field, and no concept of a package anywhere in the server** (`grep`
for `package` in `src/v2.ts`: zero). So the board can say a release happened, when it happened and
which CRs it bundled, but not **what a user can actually install** — the one fact a release exists
to produce.

Concretely, every Crucible release ships **two** packages to two registries:
`crucible-axi` (PyPI) and `@anthill-tec/crucible-server` (npm), version-locked together per the
bundling strategy. Both are known to the ceremony at publish time. Neither is recorded.

Consequences: the roadmap's release reading (CR-078) can show a date and a CR count but cannot
answer "what shipped, and where do I get it"; and a release that published *nothing* is
indistinguishable from one that published two packages, even though by the definition the former is
not a release at all.

## Scope

### §S1 The ceremony records what it published

The release milestone gains a **`packages`** entry: for each artifact, its **registry**, **name**
and **version** (and, where the registry exposes one, the canonical URL). The ceremony already
knows these — it is the actor that published them — so they are captured at report time, alongside
`releasedAt` and `crs` from CR-080, through the same single reporter.

Payload-carried, so **no migration**: `SCHEMA_VERSION` stays at its current value, exactly as
CR-080 §S4 did.

### §S2 Exposed on the release, ordered with it

`releaseBrief` exposes `packages` on `GET …/releases`, so a consumer reads version, date, CR
membership and delivered artifacts from one place.

### §S3 A release with no package is visibly wrong, not silently fine

By the definition a release always delivers a package. If a release is recorded with none, that is
surfaced (an explicit empty state on the release reading), never rendered as though the release were
complete. The record is not refused — a published release must never be blocked by a reporting
gap — but the view must not imply an artifact that does not exist.

### §S4 Backfill the shipped releases

0.1.0, 0.1.1 and 0.1.2 are recorded without packages. Because CR-080 §S3 made release records
immutable under dedup-replay, they need the same explicit repair path CR-081 introduces; this CR
reuses it rather than inventing a second one.

## Acceptance criteria

- **AC1** — a release recorded by the ceremony carries `packages` with one entry per published
  artifact, each naming registry, package name and version. For Crucible that is two entries
  (PyPI `crucible-axi`, npm `@anthill-tec/crucible-server`).
- **AC2** — the recorded package version matches the release version; a mismatch is reported rather
  than stored silently (the two registries are version-locked by strategy).
- **AC3** — `GET …/releases` exposes `packages` alongside `version`, `commit`, `releasedAt`, `crs`.
- **AC4** — a release recorded with **no** packages reads back with an explicit empty `packages`,
  and the release reading shows an explicit "no package recorded" state rather than an apparently
  complete release.
- **AC5** — provenance stays intact: adding `packages` changes neither `crs` nor `releasedAt`, and
  dedup-replay still returns the held event unchanged.
- **AC6** — no migration: `SCHEMA_VERSION` is unchanged.
- **AC7** — the three shipped releases can be repaired to carry their real packages via the CR-081
  repair path, and the repair is idempotent.

## Estimated size

S — one payload field, its exposure, capture in the ceremony, and reuse of an existing repair path.

## Risk

The ceremony must record what it **actually** published, not what it intended to. The 0.1.0 history
is the cautionary case: the tag shipped but the npm publish failed twice (`EOTP`, then `E422
provenance`), so npm had no 0.1.0 at all while PyPI did. A naive implementation that assumes "a
release publishes both packages" would have recorded a package that did not exist. Capture must
follow the publish result per artifact.

## Non-goals

- Modelling the release **workflow** itself (its steps and gates as a first-class workflow rather
  than a single milestone event) — a larger design question, deliberately not bundled here.
- Verifying a package is reachable in its registry after the fact.
- Changing `crs` or `releasedAt` semantics (CR-080), or their correctness (CR-081).
- Consuming `packages` in the roadmap reading — that is CR-078.
