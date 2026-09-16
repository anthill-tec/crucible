# CR-CRU-084 — a release records the package(s) it delivered

- **Type**: feature
- **Wave**: 5
- **Depends on**: 080, 081
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

## Gap analysis (2026-08-23, pre-RED) — READY (after the corrections below)

Run per the `gap-analysis` skill, all six dimensions, measured against the code and CI.

- **D1/D3 — the original §S1 was unimplementable, and the USER settled it.** As filed, §S1/AC1 said
  the ceremony records what it *published*, and Risk demanded capture "follow the publish result per
  artifact". It cannot: `cmd_finish` (`scripts/release.sh:774-779`) pushes the tag and calls
  `report_release` immediately, while `publish-pypi`/`publish-npm` run afterwards in CI
  (`.github/workflows/release.yml`, gated on all three suites). At record time no artifact exists.
  **Ruling (user, 2026-08-23): Crucible does not validate that a package was produced.** A release is
  recorded as delivered at `finish`, because the gates BEFORE it — no-mistakes integrity, the full
  suites, the artifact build + install-smoke, and the TestPyPI/npm-dry-run rehearsal
  (`DN-release-process.md` steps 3-6) — are what make the publish sound. So `packages` carries the
  DECLARED, version-locked coordinates, and no CI or registry outcome is consulted.
- **D2 — the fields the spec names all exist, and the payload route is a verbatim carrier.**
  `MILESTONE_TYPES` already holds `"release"` (`src/v2.ts:1067`); `releaseBrief`
  (`src/v2.ts:1664-1672`) spreads `version`/`commit`/`releasedAt`/`crs`/`timestamp`;
  `handleMilestones` (`src/v2.ts:1160-1186`) whitelists provenance and re-derives nothing.
  `grep package src/v2.ts` → 0, so the Problem statement is accurate.
- **D2/D4 — "reuse the CR-081 repair path" is FOUR seams, not free.** `packages` has to travel
  `cmd_milestone` (`clients/_crucible_axi.py:1729`) → `post_milestone` (`:2003-2005`) → the route
  whitelist (`src/v2.ts:1160-1186`, never-coerce validation) → `repairReleaseProvenance`
  (`src/store.ts:1800-1803`, whose signature is `(held, releasedAt, crs)`). Still an S, but the
  estimate must own all four.
- **D3 — the CR-086 write rule must extend to `packages`.** CR-086 §S1 drew the line at the repair
  write for `crs`/`releasedAt`: an EMPTY derivation is *no answer*, not *the answer*. AC4
  deliberately makes an empty `packages` meaningful, which is the same collision that erased 58 CRs
  from `0.1.0`. Spelled out in §S4 rather than left to the RED phase.
- **D1 — AC4 contradicted the Non-goals** (it required a release *reading* while deferring the
  reading to CR-078) and there is no release-detail surface yet: today the roadmap renders only
  `roadmap-release-divider` → `released <version>` (`public/app.js:2439-2448`). Split below.
- **D5/D6 — nothing retired, no public symbol removed.** `packages` is additive and payload-carried,
  so AC6 (`SCHEMA_VERSION` unchanged) holds by construction, exactly as CR-080 §S4.
- **Measured history (one-time input for §S4, not a mechanism).** The tags' own CI runs record what
  each release actually put on a registry: `0.1.0` → PyPI success, **npm failure** (run
  32263362644); `0.1.1` → both (32266789681); `0.1.2` → both (32312125484). So the backfill records
  `0.1.0` with the ONE package it shipped — a known historical fact supplied by hand, not a check the
  ceremony performs.

## Scope

### §S1 The ceremony records the packages it delivers

The release milestone gains a **`packages`** entry: for each artifact, its **registry**, **name** and
**version**. For Crucible that is the version-locked pair the bundling strategy fixes — PyPI
`crucible-axi` and npm `@anthill-tec/crucible-server` — and the version of both is the release tag
itself, so there is one source of truth and nothing to reconcile.

Recorded at **`finish`**, through the existing single reporter (`report_release` →
`emit_release_milestone` → the repo client), alongside `releasedAt` and `crs` from CR-080. The
ceremony does **not** wait for CI and does **not** verify that a publish succeeded: the gate ladder
before `finish` is the assurance (user ruling, see the gap analysis).

Payload-carried, so **no migration**: `SCHEMA_VERSION` stays at its current value, exactly as
CR-080 §S4 did.

### §S2 Exposed on the release, ordered with it

`releaseBrief` exposes `packages` on `GET …/releases`, so a consumer reads version, date, CR
membership and delivered artifacts from one place.

### §S3 A release with no package is visibly wrong, not silently fine

By the definition a release always delivers a package. A release recorded with **none** must
therefore read back as an explicit empty `packages` — distinguishable from a release recorded before
this CR, which carries no `packages` field at all. The record is never refused: a published release
must not be blocked by a reporting gap.

The **presentation** of that empty state belongs to the release reading, which does not exist yet and
is CR-078's surface (`DN-crucible-roadmap-view.md` decision 7b). This CR delivers the wire fact and
stops there; CR-078 renders it. The old wording required a view this CR has nowhere to put.

### §S4 Backfill the shipped releases

0.1.0, 0.1.1 and 0.1.2 are recorded without packages. Because CR-080 §S3 made release records
immutable under dedup-replay, they are corrected through the **CR-081 §S3 repair path**
(`--repair-provenance`) rather than a second mechanism — extended to carry `packages` across the four
seams the gap analysis enumerates.

That path inherits CR-086's write rule, extended to this field: an **empty** derived `packages` never
overwrites a stored non-empty one (it is "no answer", not "the answer"), while an empty `packages` on
a FIRST recording is kept, because §S3 makes it a meaningful fact. Without that distinction this CR
re-opens the defect CR-086 was filed for.

**The ceremony declares the pair on the RECORDING path only — never on a repair** (settled during
C2, measured). A repair CORRECTS an already-recorded release, while the pair is a DECLARATION made
when the release was recorded and is not re-derivable afterwards: `0.1.0` delivered PyPI only,
a historical fact no constant can know. Re-declaring the pair on every repair would overwrite that
per-release correction with a wrong one, and it would hand CR-086's refusal something to write — so a
repair whose CR derivation came back empty would stop refusing and start rewriting the release
(measured: 2 of the CR-086 regressions go red). §S4's corrections are therefore made **per release,
hand-supplied** through the client's `--packages` on its repair path; CR-086's refusal narrows to
"nothing at all to write" so those corrections can land.

## Acceptance criteria

- **AC1** — a release recorded by the ceremony at `finish` carries `packages` with one entry per
  declared artifact, each naming registry, package name and version. For Crucible that is two
  entries: PyPI `crucible-axi` and npm `@anthill-tec/crucible-server`.
- **AC2** — every entry's version IS the release version, structurally: it is taken from the same tag
  the release record is built from, never supplied per registry, so the two cannot diverge. (This
  replaces a "report a mismatch" criterion that could not fire — `publish-npm` sets the manifest from
  the tag under CR-061 §S2, and hatch-vcs derives the Python version from it.)
- **AC3** — `GET …/releases` exposes `packages` alongside `version`, `commit`, `releasedAt`, `crs`.
- **AC4** — a release recorded with **no** packages reads back with an explicit **empty** `packages`,
  and that is distinguishable on the wire from a pre-CR-084 release, which omits the field entirely.
  Rendering it is CR-078's.
- **AC5** — provenance stays intact: adding `packages` changes neither `crs` nor `releasedAt`, and
  dedup-replay still returns the held event unchanged.
- **AC6** — no migration: `SCHEMA_VERSION` is unchanged.
- **AC7** — the three shipped releases can be repaired to carry their real packages via the CR-081
  repair path, and the repair is idempotent.

## Estimated size

S — one payload field, its exposure, capture in the ceremony, and reuse of an existing repair path.

## Risk

The ceremony records what it **declares**, not what a registry later confirms — that is the settled
design, not an oversight: verifying an artifact reached its registry would put CI-and-network truth
inside a git ceremony, and the gates before `finish` already exercise the build, the installed wheel,
the composite pin and a rehearsal publish.

The residual case is honest and bounded: a publish job can still fail AFTER the record, as npm did
for `0.1.0` (PyPI shipped, npm did not). The record is then wrong until corrected — and the
correction is the same `--repair-provenance` path §S4 already uses, with no new machinery. What this
CR must not do is imply a per-artifact guarantee it does not check.

## Non-goals

- Modelling the release **workflow** itself (its steps and gates as a first-class workflow rather
  than a single milestone event) — a larger design question, deliberately not bundled here.
- Verifying a package is reachable in its registry after the fact.
- Changing `crs` or `releasedAt` semantics (CR-080), or their correctness (CR-081).
- Consuming `packages` in the roadmap reading — that is CR-078.
- Verifying that a publish actually succeeded, or that a package is reachable in its registry —
  Crucible does not validate package generation (user ruling, 2026-08-23); the pre-`finish` gate
  ladder is the assurance.
- Reading CI job outcomes in the ceremony. The one place CI history is used is the §S4 backfill of
  three already-shipped releases, as a hand-supplied historical fact.
