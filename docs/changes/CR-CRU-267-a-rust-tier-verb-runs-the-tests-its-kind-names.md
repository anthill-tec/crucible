# CR-CRU-267 — a rust tier verb runs the tests its kind names

**Status:** PENDING.

- Filed 2026-11-21 from todo #27.
- Revised 2026-11-23 after:
  - the gap analysis (`test-reports/work/cr267-gap-analysis.md`);
  - the user's rulings R1–R8, and R9 (an explicit `--profile` against a declaration is refused);
  - the spec pre-review (`test-reports/work/prereview267-report.md`, F1–F14 folded).
- The 2026-11-15 user ruling behind it: the unit, integration and e2e tier convention extends to every stack through
  one standard switch set, and each client translates that set into its stack's own strategy. Bun and python came
  first, in 0.4.0 (CR-CRU-261).

**Type:** maintenance
**Points:** 5
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** client, rust, tiers
**Design reference:**

- CR-CRU-111 §S3/AC6 and §S4/AC6b: cargo's own tier split, and the wall-versus-CPU bracket.
- CR-CRU-112 §S2: the gate's additive rule.
- CR-CRU-261: bun and python tiers, by directory.
- CR-CRU-196: go tiers, by build tag. Go refuses a selection with no test before it opens a run.

## Problem

Rust's tier verbs already run without a declaration (CR-CRU-111). But they run the wrong tests, under a profile the
project may not have:

- **`unit` is too narrow.** It runs `cargo nextest run --lib`, so in-crate tests in `bin` and `proc-macro` targets
  run under no tier verb.
- **`integration` is too wide.** cargo's `--tests` also builds the lib and bin targets in test mode, so in-crate unit
  tests run, and are filed, as `integration`. On a crate with no `tests/` directory, `integration` files nothing but
  unit tests.
- **A declaration is ignored.** A crate that declares `[profile.unit]` or `[profile.integration]` in
  `.config/nextest.toml` still gets `--lib -P ci` or `--tests -P ci`.
- **Both verbs assume a `ci` profile.**
  - The parser defaults `--profile` to `"ci"` (`rust-crucible.py:2813`, `:2818`).
  - Without `[profile.ci]`, nextest exits 96, and no Crucible refusal says why.
  - With `--agent`, the client files a false "the tests did not build" compile failure.
- **`e2e` is half wired.** It runs `-P e2e` as a built-in, so a crate with no `[profile.e2e]` gets the same raw exit
  96. Every other stack treats `e2e` as declared-only.

## Behaviour

S1–S4 apply to the `unit` and `integration` verbs only. S6 lists what stays as it is.

### S1: the verb runs the stack's own split

With no `[profile.<tier>]` declared, the client selects the tier's tests with a nextest kind filter, passed as one
argv element after `-E`:

| Verb | Filter |
|---|---|
| `unit` | `kind(lib) &#124; kind(bin) &#124; kind(proc-macro)` |
| `integration` | `kind(test)` |

- **A user's `--filter X` narrows the selection.** The single element becomes `(<kinds>) & (X)`. The client never
  passes a second `-E`, because that would widen the run.
- **`integration --test it`** passes `--test it` as today. The kind filter is still passed, so one rule holds.
- **No more cargo target flags.** `--lib` and `--tests` are no longer passed.

### S2: a declaration wins

- **A declared profile.** A crate that declares `[profile.<tier>]` in `.config/nextest.toml` runs `-P <tier>`. No kind
  filter is passed: the profile is the selection, as for `module` and `bdd` today. A user's `--filter X` is passed as
  `-E X`, as today.
- **R9: an explicit `--profile` refused.** An explicit `--profile p` on a tier whose `[profile.<tier>]` is declared is
  refused before anything runs, with or without `--agent`. The refusal names the declared `[profile.<tier>]`, and says
  that a declared tier always runs its declaration.

### S3: the profile chain, when the tier is undeclared

The chain resolves in `cmd_test`, before anything runs. It applies on both the agent path and the no-agent path, and
before `_nextest_refusal` and `gated_run`.

1. **An explicit `--profile p`.**
   - If `p` is declared in `.config/nextest.toml`, or is one of nextest's built-ins (`default`, `default-miri`), the
     verb runs `-P p`, keeping the kind filter.
   - Otherwise the verb is refused, naming the `[profile.p]` line to add. It files no compile failure and starts no
     nextest.
2. **No flag, and `[profile.ci]` declared:** `-P ci`.
3. **Otherwise:** `-P default`. It is passed explicitly, so a `NEXTEST_PROFILE` in the environment does not change it.

Three more rules:

- **The parser.** `--profile` defaults to `None` on `unit` and `integration`.
- **The resolved name is used downstream.** `_targets_refusal` and the junit claim read the resolved profile name, so
  a `[targets.ci]` entry is still checked when the chain picks `ci`.
- **An unreadable config.** An unparseable `.config/nextest.toml` is refused, naming the file. It is never filed as a
  compile failure.

### S4: an empty kind-filter selection refuses

This covers the undeclared selection only: S1's kind filter, with or without `--filter`.

**Where the check runs.**

- It runs in `_test_run`, for `unit` and `integration` only, on both the agent path and the no-agent path.
- It runs before any run is opened and before the plain run.
- It is one `cargo nextest list --message-format json`, with the run's exact argv selection, run inside the
  `ChildRunTiming` bracket (CR-CRU-111 §S4). The listed output is handed on, so the crate is not listed twice.

**When the selection is empty.**

- The selection is empty when the list names no testcase whose `filter-match.status` is `matches`, and none that is
  only `#[ignore]`d. A tier whose only tests are ignored is not empty.
- A list that exits non-zero is never an empty selection. It falls through to today's path, so a crate that does not
  build still files its compile failure against the run that path opens.

**The refusal.**

- The code is `tier-selection-empty`. It is rust's own, as go's pre-run refusal is go's.
- `ok:false`, naming:
  - the tier;
  - the kind filter;
  - the user's `--filter`, when one was given;
  - the `[profile.<tier>]` that would replace it.
- No `POST /runs/start` is made, and no compile failure is filed.

**A declared profile that matches nothing** keeps today's path.

### S5: `e2e` is declared-only

- **It becomes a declared cell,** like `module` and `bdd`.
  - With `[profile.e2e]` declared, it runs `-P e2e` as today.
  - Without one, it answers the shared `tier-run-undeclared` refusal, whose help names `[profile.e2e]`.
- **It loses `--profile`, a contract change.** It keeps the declared-cell flags (`--crate`, `--features`, `--filter`,
  `--no-fail-fast`, `--agent`, `--cycle`, `--release`, `--log`, `--reports`, `--project-dir`), so
  `e2e --profile x` is now an argparse error, exit 2. No caller in this repo passes it.

### S6: what stays

- **`test`, `regression` and the gate.**
  - Their argv is unchanged. They still pass `-P ci`, and they still exit 96 on a crate with no `[profile.ci]`. That
    is a non-goal.
  - `regression` is one run, filed under `regression` (R6).
  - The gate is one whole run, with a `coveredBy` row per declared tier (CR-CRU-112's additive rule, R5).
- **`module` and `bdd`** are unchanged (R3).

### S7: one switch set

The tier verbs and `tier-run-undeclared` are shared. S4's `tier-selection-empty` and the translation (the kind filter
and the profile chain) are Rust's own.

## Acceptance criteria

**How the ACs are tested.**

- The tests drive the client as a subprocess, against today's fake `cargo nextest`, which records argv and answers
  canned list and run output (`FAKE_NEXTEST_CASES`).
- `test_a_rust_run_streams_real_nextest_end_to_end` runs real cargo-nextest, which CI installs. It is the in-suite
  real-crate proof (R8).
- Mainline also runs `unit` and `integration` on a scratch crate at close-out. That run is reviewed, not tested.

**AC1: the split.** On an undeclared crate with `[profile.ci]`:

- `unit` hands nextest exactly `-P ci -E "kind(lib) | kind(bin) | kind(proc-macro)"` (one `-E` element), and no
  `--lib`;
- `integration` hands it `-P ci -E "kind(test)"`, and no `--tests`;
- each run is filed under its own tier;
- with `--filter X`, the one `-E` element is `(kind(lib) | kind(bin) | kind(proc-macro)) & (X)`;
- `integration --test it` passes `--test it` and `-E "kind(test)"`.

**AC2: the declaration wins.**

- With `[profile.unit]` declared, `unit` runs `-P unit` with no kind filter. The same holds for `integration`.
- `unit --profile p` with `[profile.unit]` declared is refused, on both paths, before nextest starts. The refusal
  names `[profile.unit]`.

**AC3: the profile chain.** On an undeclared tier:

- `[profile.ci]` present: `-P ci`;
- no `[profile.ci]`: `-P default`, even with `NEXTEST_PROFILE` set;
- `--profile p` with `[profile.p]`: `-P p`, keeping the kind filter;
- `--profile default` with no config file: `-P default`;
- `--profile p` with no `[profile.p]`: refused, naming `[profile.p]`, on both paths. Nextest does not start, no compile
  failure is filed, and no run is opened;
- an unparseable `.config/nextest.toml`: refused, naming the file;
- a `[targets.ci]` entry that does not suit the run is still refused when the chain picks `ci`.

**AC4: the empty selection.** For `integration` on a crate whose list holds no `test`-kind testcase:

- the answer is `ok:false`, code `tier-selection-empty`, naming the tier and `kind(test)`;
- no `POST /runs/start` is made, and no compile failure is filed;
- the same holds without `--agent`;
- a list that holds only `#[ignore]`d test-kind tests is not refused;
- a list that fails to build still files the compile failure, as today
  (`TheNoReportExitIsUnchangedTest`, unchanged).

**AC5: `e2e`.**

- Undeclared, it answers `tier-run-undeclared`. Its help names `[profile.e2e]`, and the refusal's help line reads
  `tier verbs this client runs today: integration, regression, unit`.
- Declared, it runs `-P e2e`.
- `e2e --profile e2e` exits 2.

**AC6: what stays.** `regression` and the gate's rust leg hand nextest today's argv. `regression` is filed under
`regression`, and the gate is one run with the `coveredBy` rows.

**AC7: docs.** Reviewed, not tested.

- **A new rust section in `docs/RUNBOOK.md`** says how each tier is found:
  - the kind filters, and how `--filter` narrows them;
  - that `[profile.<tier>]` wins, and that an explicit `--profile` is refused against it;
  - the profile chain;
  - the `tier-selection-empty` refusal;
  - that `e2e` is declared-only;
  - that doctests run under no verb (R7);
  - that, without a `default-filter`, `integration` under nextest's built-in `default` profile includes any docker
    tier.
- **Help text.** The `unit`, `integration` and `e2e` help matches.
- **`clients/crucible.toml:191–199`** lists `unit` and `integration` under the `ci` profile's users, and states the
  chain.
- **`CHANGELOG.md`** gets a `## [Unreleased]` `### Changed` entry. It names `e2e` losing `--profile`.

## Tests

### Modules this CR changes

- **`tests/client/integration/test_client_tier_run_modality.py`:**
  - `RustSplitCellsTest` asserts the kind filters, not `--lib`/`--tests`.
  - Its `e2e` test moves to a declared-cell test.
  - `RustSplitCellsDoNotRefuseTest` covers `unit` and `integration` only.
  - `TOOLCHAIN_SPLIT_CELLS["rust"]` drops `e2e`.
- **`tests/client/integration/test_client_tier_run_envelope.py`:**
  - `RustIngestedTierEnvelopeTest.test_a_zero_discovery_run_states_what_it_ingested` drives `regression`, which still
    opens and files a zero-discovery run, through `RUST_ZERO_DISCOVERY_VERB = "regression"`. This follows go's
    precedent.
- **`tests/client/integration/test_a_rust_run_streams_real_nextest_end_to_end.py`:**
  - `RUNS` gets the new counts: `unit` gains `nx-targets`' bin test `tool_starts`, and `integration --crate nxpass`
    loses its lib tests.
  - Labels drop `--lib` and `--tests`.
- **New tests for S2–S5:** these go in the modules above, or in a new module named for the behaviour.

### Tests to delete

These read source text, read a spec, or test the test file's own classes. The user's rule is that a test's subject
is production code that runs.

- **`test_client_tier_run_modality`:** `SplitCellCoverageTest`.
- **`test_client_tier_run_envelope`:**
  - `Ac7PathCountTest`;
  - `ExitPathCoverageTest`;
  - `TierLessEnvelopeIsHonestTest`;
  - `TierRunUndeclaredClaimsNothingTest`;
  - the source scan they rely on.
- **`test_client_tier_stamping`:**
  - `UnearnedTierLiteralCensusTest`;
  - `CensusInstrumentSeesEverySpellingTest`;
  - `CompileIngestCarriesNoTestTierTest`.
- **`test_client_tier_declaration_detection`:** `DeclaredCellCoverageTest`.
- **`test_client_unit_tier_wall_vs_cpu`:** its source-text scan (`:216`), if the CR touches the module.

### Unchanged

`TheNoReportExitIsUnchangedTest` in `test_rust_client_sends_its_runners_reports.py`.

## Non-goals

- **Per-tier gate runs,** filed separately with merged coverage (R5). That would be a CR of its own.
- **`test`, `regression` and the gate leaving `-P ci`,** and their exit 96 on a crate without one.
- **Doctests** (`cargo test --doc`), which nextest does not run (R7).
- **The other stacks:** maven is CR-CRU-268 and arduino is CR-CRU-269.
- **Model B's agent and skill wording.** Crucible sends the switch set to Model B as a request once the stack CRs
  land.
