# CR-CRU-267 — a rust tier verb runs the tests its kind names

**Status:** PENDING. Filed 2026-11-21 from todo #27, then revised 2026-11-23 after the gap analysis
(`test-reports/work/cr267-gap-analysis.md`) and the user's rulings R1–R8.

- **The 2026-11-15 user ruling behind it:** the unit, integration and e2e tier convention extends to every stack
  through one standard switch set. Each client translates that set into its own stack's strategy.
- **Earlier stacks:** bun and python came first, in 0.4.0 (CR-CRU-261).
- **Timing:** filed for 0.5.0, after the 0.4.0 release.

**Type:** maintenance
**Points:** 5
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** client, rust, tiers
**Design reference:**
- CR-CRU-111 §S3/AC6: cargo's own tier split, reachable from a tier verb.
- CR-CRU-112 §S2: the gate's additive rule.
- CR-CRU-261: bun and python tiers, by directory.
- CR-CRU-196: go tiers, by build tag.

## Problem

Rust's tier verbs already run without a declaration (CR-CRU-111). But they run the wrong tests, under a profile the
project may not have:

- **`unit` is too narrow.** It runs `cargo nextest run --lib`, so in-crate tests in `bin` and `proc-macro` targets run
  under no tier verb.
- **`integration` is too wide.** cargo's `--tests` also builds the lib and bin targets in test mode, so the in-crate
  unit tests run, and are filed, as `integration`. A crate with no `tests/` directory files only unit tests as
  `integration`.
- **A declaration is ignored.** A project that declares `[profile.unit]` or `[profile.integration]` in
  `.config/nextest.toml` still gets `--lib -P ci` or `--tests -P ci`.
- **Both verbs assume a `ci` profile.**
  - Without `[profile.ci]`, nextest exits 96, and no Crucible refusal explains why.
  - With `--agent`, the client then files a false "the tests did not build" compile failure.
- **`e2e` is half wired.** It runs `-P e2e` as a built-in, so a crate with no `[profile.e2e]` gets the same raw
  exit 96. Every other stack treats e2e as declared-only.

## Behaviour

- **S1: the verb runs the stack's own split.** Without a declaration, the client selects the tier's tests with a
  nextest kind filter:
  - `unit` selects `kind(lib) | kind(bin) | kind(proc-macro)`, the in-crate tests;
  - `integration` selects `kind(test)`, the crate's `tests/` targets.

  A user's `--filter` is ANDed with the kind filter: `(kinds) & (filter)`. A second `-E` would widen the run, so the
  client never passes one. `integration --test <name>` keeps narrowing to that one target.
- **S2: a declaration wins.** A crate that declares `[profile.<tier>]` in `.config/nextest.toml` runs that profile,
  for `unit` and `integration` as for every tier. The kind filter does not apply: the profile is the selection, as for
  `module` and `bdd` today.
- **S3: the profile, when nothing is declared.**
  1. An explicit `--profile` wins.
  2. If there is none, an undeclared `unit` or `integration` runs `-P ci` when the project declares `[profile.ci]`.
  3. Otherwise it runs nextest's `default` profile.

  A profile the project does not have is never handed to nextest. A `--profile` naming an absent profile is refused,
  naming the `[profile.<name>]` line to add. It is never filed as a compile failure.
- **S4: an empty selection refuses.** When the tier's selection holds no test, the verb answers `ok:false` and names:
  - the tier;
  - what it selects;
  - the declaration that would replace it.

  For example, `integration` on a crate with no `tests/` directory. It files no run and no compile failure.
- **S5: `e2e` is declared-only.**
  - It joins `module` and `bdd` as a declared cell.
  - A declared `[profile.e2e]` runs as today.
  - Without one, it answers the shared `tier-run-undeclared` refusal, naming `[profile.e2e]`.
  - The help's "tier verbs this client runs today" list drops `e2e`.
- **S6: what stays.**
  - `regression` stays one run, filed under `regression`, as on every stack (R6).
  - The gate keeps its one whole run, with a `coveredBy` row per declared tier (CR-CRU-112's additive rule, R5).
  - Both keep `-P ci`.
  - `module` and `bdd` are unchanged (R3).
- **S7: one switch set.** The verbs and the refusal codes and wording are the ones the other clients use. Only the
  translation (kind filter, profile) is Rust's.

## Acceptance criteria

The client runs tests drive the client as a subprocess, against a fake `cargo` that records its argv and answers
canned list and run output (R8). A real-crate check is done by Mainline at close-out. It is reviewed, not tested.

- **AC1: the split.** On an undeclared crate:
  - `unit` hands nextest `-E 'kind(lib) | kind(bin) | kind(proc-macro)'`, with no `--lib`;
  - `integration` hands it `-E 'kind(test)'`, with no `--tests`;
  - each run is filed under its own tier;
  - with `--filter X`, the single `-E` is `(kinds) & (X)`;
  - `integration --test it` still narrows to target `it`.
- **AC2: the declaration wins.** With `[profile.unit]` declared, `unit` runs `-P unit` and passes no kind filter. The
  same holds for `integration`.
- **AC3: the profile chain.** On an undeclared crate:
  - `unit` runs `-P ci` when `[profile.ci]` exists;
  - it passes no `-P` at all (nextest's default) when there is no `[profile.ci]`;
  - an explicit `--profile p` runs `-P p` when `[profile.p]` exists;
  - when `[profile.p]` is absent, the verb is refused, naming `[profile.p]`, with no compile failure filed and no
    nextest run.
- **AC4: the empty selection.** `integration` on a crate whose list holds no `test`-kind test answers `ok:false`. It
  names the tier and the `kind(test)` selection, and files no run and no compile failure.
- **AC5: `e2e`.**
  - Undeclared, `e2e` answers `tier-run-undeclared`, with help naming `[profile.e2e]`.
  - Declared, it runs `-P e2e`.
  - The help's run-today list is `integration, regression, unit`.
- **AC6: what stays.** `regression` runs today's argv, filed under `regression`. The gate's rust leg is unchanged:
  one run, with the `coveredBy` rows.
- **AC7: docs, reviewed and not tested.**
  - A new rust section in `RUNBOOK.md` says how each tier is found: the kind filters, `[profile.<tier>]` winning, the
    profile chain, the empty-selection refusal, e2e declared-only, and that doctests run under no verb (R7).
  - The `unit`, `integration` and `e2e` help text matches.
  - `CHANGELOG.md` gets a `## [Unreleased]` `### Changed` entry.

## Tests to remove

These tests break the user's rule that a test's subject is production code that runs. Any of them in a module this
CR touches is deleted, not adapted:
- the AST and source-text census classes (`UnearnedTierLiteralCensusTest`, `CensusInstrumentSeesEverySpellingTest`,
  `CompileIngestCarriesNoTestTierTest`);
- the meta-tests over a test file's own classes (`SplitCellCoverageTest`, `DeclaredCellCoverageTest`).

## Non-goals

- Per-tier gate runs, with tiers filed separately and coverage merged (R5). That would be a CR of its own.
- `regression` and the gate leaving `-P ci`.
- Doctests (`cargo test --doc`), which nextest does not run (R7).
- The other stacks: maven is CR-CRU-268 and arduino is CR-CRU-269.
- Model B's agent and skill wording. Crucible sends the switch set to Model B as a request once the stack CRs land.
