# CR-CRU-196 — a Go project declares its tiers with build tags

**Type** feature · **Points** 5 (provisional, set at filing 2026-10-18; the estimate is revisited at
gap analysis) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-195 · **Status** PENDING — filed
2026-10-18 (Model B request, user ruling: Go's tiers are declared by build tag)

## Problem

Raised by Model B (2026-10-18) with the Go client, CR-CRU-195. Every client declares a run's tier,
and each stack declares its tier targets in its own native place: bun in `package.json` scripts,
rust in nextest profiles, maven in `pom.xml` profiles. Go has no script table. In Go, an
integration tier is usually a build tag (`//go:build integration`), and the project's own services
bring up the backends that tier needs.

## Design (settled with the user, 2026-10-18)

- **A tier is a build tag of the same name.** A module declares tier `<tier>` when a test file in
  it carries the `<tier>` build constraint. The tier's run is `go test -tags <tier>`, ingested
  under that tier.
- **The gate composes over them** as it does for every stack (CR-CRU-112): each declared tier is a
  declared suite.

## Scope

### §S1 — the declaration surface

The Go client's `DeclaredTierSurface` reads a tier's declaration from the module's build
constraints and runs it with the matching tag. A tier with no declaration is refused, as every
client refuses one, and the refusal names what declares it.

### §S2 — the gate covers every declared tier

`pre-merge-gate` enumerates the module's declared tiers and runs each under its tag.

## Acceptance criteria

- [ ] **A tag declares a tier.** In a module with an `integration`-tagged test file, `integration`
      runs `go test -tags integration` and ingests the run under tier `integration`.
- [ ] **An undeclared tier is refused.** With no `e2e`-tagged file, `e2e` is refused before
      anything runs, and the refusal names the build constraint that would declare it.
- [ ] **The gate covers every declared tier.** `pre-merge-gate` on a module declaring `integration`
      runs and reports it as a declared suite beside the untagged run.

## Non-goals

- Bringing up a tier's backends. That is the project's own services.
