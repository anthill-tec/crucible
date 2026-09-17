# CR-CRU-015 — the BDD tier is wired to the suite that already runs

**Type** feature · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-004, CR-CRU-007 · **Status** PENDING

> **RE-SPECIFIED 2026-09-17 (user ruling, option 2).** The original CR — filed at kickoff, when
> Crucible was "not just a sink" — had the SERVER execute Playwright against a project's `sutRoot`
> on demand, driven by a dashboard button. That premise is retired: since CR-CRU-030 every tier in
> this system is run BY the client and ingested, which is why `bdd` is already a declared tier in
> the fleet's own vocabulary. A server that spawns test runs would be a SECOND execution mechanism
> for something the fleet owns, inside an unauthenticated HTTP service whose own configuration
> comments warn it "stays LOOPBACK unless an operator deliberately widens it". The stale header
> (`Status: PENDING (0.2.0)`, `Phase: Wave 5`, "runs as track-2 in parallel with CR-CRU-014") is
> corrected with it; CR-CRU-014 shipped in 0.2.0.

## Problem

Every piece of the BDD path exists, and nothing connects them. Measured on `develop` at `fe7794c`:

| Piece | State |
|---|---|
| Gherkin features | **16** under `tests/e2e/features/` |
| The harness that runs them | `package.json`'s `test:e2e` — `bunx bddgen && bunx playwright test` (playwright-bdd) |
| The `bdd` tier | declared server-side (`src/v2.ts:687`) and in the fleet vocabulary (`clients/_crucible_axi.py:4904` — *"executable specifications, in the project's own BDD form"*) |
| The playwright codec | `src/codecs/playwright.ts`, 125 lines, registered in the codec map as `"playwright"` (`src/codecs/index.ts:20-27`), unit-tested by `tests/playwright-codec.test.ts` |
| A `test:bdd` declared target | **absent** |
| Any client that selects the codec | **none** — `grep playwright clients/*.py` returns zero hits |
| A BDD surface | absent, and the UI says so at `public/app.js:2644`: *"BDD run results already stream into the Runs timeline — a dedicated BDD surface does not exist yet"* |

So sixteen executable specifications run on every CI push and **not one of their results reaches
Crucible as `bdd`**. They are collected under `test:e2e`, which the pre-merge gate excludes
fleet-wide (DN open question 5), so the BDD suite is the least-reported tier in the project while
being the one written in the project's own domain language.

And the `playwright` codec is **dead in the real workflow**: reachable only through the raw API, never
selected by the fleet. A codec no caller selects is not a feature, it is an unexercised parser — the
same shape CR-CRU-140 found in the cycle-evidence read, where the capability existed and nothing
pointed at it.

## Scope

### §S1 — the project's BDD suite is a declared target, run and filed as the `bdd` tier

`package.json` declares the BDD target the fleet's `bdd` verb already looks for, so
`bun-crucible.py bdd` runs this project's own Gherkin suite rather than failing to resolve a target.
The relationship to `test:e2e` is decided rather than left ambiguous: the BDD target names the
playwright-bdd run, and whether `test:e2e` remains a separate declaration or becomes an alias of it
is settled by measurement (does the existing e2e job collect anything the BDD target does not?) and
stated in the CR at RED time.

The run is filed under `tier: bdd` — not `e2e`, not `unstated`. A tier names the dependency a test
takes; a Gherkin suite driven through a real browser is the project's own BDD form, which is exactly
what the fleet's vocabulary entry says.

### §S2 — the playwright codec stops being dead

The ingest path that carries a playwright report selects the `"playwright"` codec, so the parser the
project already owns and tests is the one that reads a playwright run. Whether the client posts the
report for server-side decoding (`format: "playwright"`) or parses locally and posts `runs/parsed`
is a real choice with a measurable answer — playwright's JSON reporter carries per-step detail a
JUnit conversion discards — and the CR settles it against what the board can actually render rather
than by preference.

**Non-vacuity is the point:** an AC must prove the codec is reached by a REAL client invocation, not
by a unit test calling `parsePlaywright` directly. It has had unit coverage all along; what it has
never had is a caller.

### §S3 — the BDD surface the UI says is missing

`public/app.js:2644` states the gap in its own words. The BDD tab renders this project's executable
specifications: scenario-level outcomes from the codec's parse, not a second Runs timeline. Scope is
the surface the tab row has promised since CR-CRU-007; the greyed tab either renders BDD results or
stops claiming it will.

## Acceptance criteria

**§S1**
- [ ] `package.json` declares the BDD target the fleet's `bdd` verb resolves, and
      `bun-crucible.py bdd` runs this project's 16-feature Gherkin suite through it — evidenced by
      the run's own output naming the features, not by the verb exiting zero.
- [ ] That run is ingested with `tier: bdd`, asserted on the stored event rather than on the
      client's claim.
- [ ] The `test:e2e` / BDD-target relationship is stated in the CR and asserted: whichever is
      chosen, no suite silently stops being collected — a test compares what each target collects
      before and after.
- [ ] The declared-target guard (`tests/ci-toolchain-provisioning.test.ts` and the declared-target
      tests CR-CRU-133 established) covers the new target, so a fifth declared target cannot appear
      unguarded.

**§S2**
- [ ] A REAL client invocation causes the `"playwright"` codec to parse the run — asserted by
      driving the client and observing the codec's own output shape in the stored event, with the
      test failing if the run was decoded as `junit` instead.
- [ ] The choice between server-side decode and client-side parse is recorded in the CR with the
      measurement that decided it (what per-step detail survives each path).
- [ ] `tests/playwright-codec.test.ts` keeps its unit coverage unchanged — this CR adds a caller, it
      does not rewrite the parser.

**§S3**
- [ ] The BDD tab renders scenario-level results for a real ingested BDD run, and
      `public/app.js:2644`'s "does not exist yet" note is deleted because it is no longer true.
- [ ] A Chromium-tier test drives the tab against a real ingested BDD run and asserts scenario
      outcomes are rendered — the storyboard compliance bar, not a smoke check.
- [ ] With no BDD run recorded, the tab shows a definitive empty state rather than a broken or
      greyed surface (CR-CRU-078's empty-state rule).

## Estimated size

Medium. §S1 is a declaration plus wiring the verb; §S2 is a codec selection and the proof it is
reached; §S3 is a real UI surface with a Chromium-tier test, which is where most of the work is.

## Risk

- **`test:e2e` already collects these features.** A careless §S1 could double-collect them or stop
  collecting them — which is why an AC compares what each target collects either side of the change.
- **The e2e tier is excluded from the pre-merge gate.** Filing BDD runs correctly does not put them
  in the gate; who runs and gates the browser tiers is DN open question 5, still unanswered, and this
  CR does not pre-empt it.

## Non-goals

- **Server-side execution of Playwright** (the original premise): retired by user ruling. Crucible
  ingests; the client runs. No dashboard button that spawns a suite, no `sutRoot` execution.
- Renaming or removing `test:e2e`, beyond whatever §S1's measured relationship decision requires.
- Answering DN open question 5 (who runs and ingests the browser tiers).
- Rewriting the playwright codec. It works and is tested; it lacks a caller.
