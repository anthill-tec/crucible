# CR-CRU-268 — a maven tier verb runs the tests its plugin names

**Status:** PENDING.

- Filed 2026-11-21 from todo #27.
- Revised 2026-11-23 after the gap analysis and the user's rulings M1–M11, recorded in
  `test-reports/work/cr268-gap-analysis.md`.
- The user ruled that `settings.xml` profiles are accepted, and approved the spec on 2026-11-23.

| Field | Value |
|---|---|
| Type | maintenance |
| Points | 5 |
| Wave | 9 (0.5.0) |
| Depends on | CR-CRU-267 (the switch set: its verbs, `--profile` rule and `tier-selection-empty`) |
| Labels | client, maven, tiers |
| Design reference | CR-CRU-111 §S3/AC6; CR-CRU-237; CR-CRU-261; CR-CRU-267 |

## Problem

The filed premise, that an undeclared Maven tier is refused, is wrong. CR-CRU-111 wired `unit`, `module`,
`integration` and `e2e` to Maven's lifecycle with no declaration; only `bdd` is declared-only. A survey with real
Maven 3.9.9 found what is actually wrong:

1. **`integration` files the wrong tests.** It files surefire's unit tests together with failsafe's. On a project
   with no failsafe, it files only unit tests, labelled `integration`.
2. **A declared tier profile is ignored.** A `pom.xml` profile whose id is `unit`, `module`, `integration` or `e2e`
   is never activated by its verb. Only `bdd` reads it, and even then it runs `clean test`, so failsafe never runs.
3. **An empty selection is filed as a build failure.** A run that produces no report starts a second
   `mvn test-compile` and files the result as a compile record. This is the same false "did not build" that
   CR-CRU-267 removed from rust.
4. **`--profile` accepts anything.** An unknown `--profile` only makes Maven warn, and the run goes on.
5. **`module` without `--module` is just `unit`,** and **`e2e` without a declaration runs the same tests as
   `integration`.**
6. **`e2e --failsafe-only` can file stale reports,** because it runs without `clean`.
7. **The gate's `coveredBy` rows overclaim.** They name declared profiles that the gate's one run never activated.
8. **The help text is wrong** for `unit`, `integration` and `bdd`, and the root description leaves out
   `integration`.

## Behaviour

**S1 — `integration` runs failsafe's tests and files only them.** With no declared `integration` profile, the argv
is:

```text
mvn clean verify -Dtest='!*' -Dsurefire.failIfNoSpecifiedTests=false
```

plus the user's Maven flags (`--module`, `--also-make` and so on).

- Surefire runs nothing. Failsafe runs its integration tests, and failsafe's own `verify` decides the verdict.
- Only failsafe reports are read and filed, under `integration`.
- A `--system-prop` that sets `test` is refused before anything runs.

**S2 — `unit` is unchanged.** With no declared `unit` profile, `unit` runs `mvn clean test [-Dtest=<pattern>]` and
files surefire's reports.

**S3 — `module` needs a module (ruling M1).**

- `module --module <m>` runs `mvn clean test -pl <m> [-am]`, as today.
- A declared `module` profile runs as S5 says.
- With neither, it is refused (`tier-run-undeclared`), and its help names both ways to run it.

**S4 — `e2e` and `bdd` are declared-only (rulings M2 and M3).**

- With no declared profile, each answers `tier-run-undeclared`.
- A declared `e2e` keeps `--with-docker`, `--compose-file`, `--no-wait` and `--failsafe-only`.
- `e2e --failsafe-only` runs `failsafe:integration-test failsafe:verify -P e2e`. It files only failsafe reports,
  and none written before the run started.

**S5 — a declared profile wins (ruling M8).** A profile whose id is the tier, declared in the Maven directory's
`pom.xml`, takes over that tier's verb.

| Verb | Argv |
|---|---|
| `unit`, `module` | `mvn clean test -P<tier>` |
| `integration`, `e2e`, `bdd` | `mvn clean verify -P<tier>` |

- The project's profile decides what runs. So the run files every surefire and failsafe report it wrote, and
  `-Dtest='!*'` is not added.
- `unit --test` and `module --module` still apply under a declared profile.
- `-P<tier>` turns off any `activeByDefault` profile. The RUNBOOK says so.

**S6 — `--profile` (ruling M9).** Checked before anything runs, on `unit`, `module`, `integration`, `e2e` and `bdd`:

- On a tier with a declared profile, any `--profile` is refused, as rust's R9 refuses it. The refusal names the
  declared profile.
- On an undeclared tier, a `--profile` id is refused, naming the id, when it is declared in neither of these:
  - any `pom.xml` under the Maven directory (nothing under `target/` counts);
  - `~/.m2/settings.xml`.

  A profile in a parent POM outside the project is refused; the RUNBOOK says so. A comma list (`-Pa,b`) is checked
  id by id. Ids written as `?id` (optional) or `!id` (deactivate) are passed through unchecked.
- `regression` and the gate are not changed.

**S7 — an empty selection is refused (rulings M4 and M7).** Maven has no list step, so the check is made after Maven
exits and before anything is filed, on both paths. A selection is empty when either:

- Maven exits 0 and the reports the verb reads hold no test case. This includes a project without failsafe, where
  `integration` answers empty and the message names failsafe;
- Maven fails, and its console carries surefire's or failsafe's "No tests matching pattern" message.

What an empty selection does:

- It answers `ok:false` with the code `tier-selection-empty`, and exits 1.
- **With `--agent`:** the opened run is aborted. No compile record is filed, no second Maven run is made, and the run's
  gated identity is closed.
- **Without `--agent`:** the same answer; nothing is posted.

A run with no reports whose console has no such message is still a build failure, and takes today's compile path.
The code `tier-selection-empty` is moved from `clients/rust-crucible.py` to the shared module, so both clients use one
code.

**S8 — what stays (ruling M10).**

- `regression` is one `mvn clean verify` run, filed under `regression`.
- The gate's maven leg is one run with no profiles.
- The gate's `coveredBy` row for a declared Maven profile says the profile was not activated, so the row no longer
  claims what the run did not do.

**S9 — help and docs.**

- The tier verbs' help states what each verb runs:
  - S1's argv for `integration`;
  - `unit`'s `-Dtest`, only with `--test`;
  - `bdd`'s and `e2e`'s declared profile.

  The root description lists `integration`.
- `docs/RUNBOOK.md` gains a "Maven tier verbs" section, beside "Rust tier verbs":
  - what each verb runs, declared and not;
  - the `--profile` rule;
  - the empty answer;
  - `activeByDefault`.
- `CHANGELOG.md`'s `## [Unreleased]` gains one entry.

## Acceptance criteria

**AC1 — the split, on real Maven (ruling M11).** A provisioned test project pins surefire and failsafe 3.5.4 and holds
`FooTest` and `FooIT`. It has no tier profile.

- `unit` files exactly `FooTest`, under `unit`.
- `integration` files exactly `FooIT`, under `integration`.

**AC2 — the argv.** A lifecycle-aware fake `mvn` shows:

- S1's argv for `integration`;
- S2's for `unit`;
- S3's refusal, and `module --module m`'s `-pl m`;
- S5's argv for each declared tier.

A `--system-prop test=x` on `integration` is refused, with no Maven run.

**AC3 — declared-only (S4).**

- Undeclared `e2e` and `bdd` answer `tier-run-undeclared`, with no Maven run and no board call.
- Declared, each runs S5's argv.
- `e2e --failsafe-only` files neither a surefire report nor a failsafe report older than the run.

**AC4 — `--profile` (S6).** Each of these is refused before Maven runs, naming what it names:

- `--profile x` on a tier with a declared profile;
- an undeclared `--profile` id.

An id declared only in a test-owned `~/.m2/settings.xml` (under a temporary `HOME`) is accepted. `--profile '?x'` and
`--profile '!x'` pass through to Maven.

**AC5 — an empty selection (S7).** These answer `tier-selection-empty` and exit 1, with no compile record and no
second Maven run:

- `integration` on a project without failsafe tests;
- `integration` on a project without failsafe at all;
- `unit --test Nope`.

On the agent path, the run is aborted and its gated identity closed. A real compile error still files its compile
record.

**AC6 — what stays (S8).**

- `regression` hands Maven today's argv.
- The gate makes one run.
- A declared profile's `coveredBy` row says the profile was not activated.

**AC7 — docs (S9).** The help, the RUNBOOK section and the CHANGELOG entry say what S9 says. Reviewed, not tested.

## Non-goals

- Coverage: JaCoCo stays as it is.
- Refusing an empty selection before Maven runs. This was declined: it costs about 1 s per run and is approximate.
- Per-tier gate or `regression` runs (R5 and R6).
- Model B's agent and skill wording.
