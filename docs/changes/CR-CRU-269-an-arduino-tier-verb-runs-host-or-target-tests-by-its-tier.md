# CR-CRU-269 — an arduino tier verb runs host or target tests by its tier

**Status:** COMPLETED (shipped 2026-11-25 on develop).

- Filed 2026-11-21 from todo #27. The user ruled on 2026-11-15 that the unit/integration/e2e tier convention extends to
  every stack through one standard switch set, which each client translates to its own strategy.
- Revised 2026-11-24 after the gap analysis and the user's rulings of that day, recorded below under "Rulings".

| Field | Value |
|---|---|
| Type | maintenance |
| Points | 5 |
| Wave | 9 (0.5.0) |
| Depends on | CR-CRU-267 (the switch set: its verbs and `tier-selection-empty`) |
| Labels | client, arduino, tiers |
| Design reference | CR-CRU-111 (arduino's split cell); CR-CRU-112 (the additive gate); CR-CRU-211 (an arduino agent runs only its own native tests); CR-CRU-261; CR-CRU-267; CR-CRU-268 |

## Problem

The filed premise, that the arduino tier verbs run only a declared `junit-<tier>` make target, is half wrong. Today
(`clients/arduino-crucible.py`, the tier verbs registered through `_crucible_axi.add_tier_verbs`):

| Verb | With `junit-<tier>` declared in the Makefile under `--dir` | Without |
|---|---|---|
| `unit` | `make junit`. **The declaration is ignored.** | `make junit`, filed under `unit` |
| `regression` | `make junit` | `make junit`, filed under `regression` |
| `module`, `integration`, `e2e`, `bdd` | `make junit-<tier>`, filed under the tier | refused, `tier-run-undeclared` |
| `pre-merge-gate` | `make junit` plus each declared `junit-<tier>`; `e2e` excluded | `make junit` alone |

`--dir` defaults to `tests/native` on every verb. What is actually wrong:

1. **Tests that need the board have no place.** A firmware project keeps hardware-in-the-loop (HIL) tests beside its
   native ones. Sheetal's live in `tests/hil` (`make junit`, pytest over a serial port). The only way to run them is
   `unit --dir tests/hil`, which files hardware results under `unit`.
2. **An absent rig files green.** A HIL suite skips every case when no board answers, and the client files a run of
   skipped cases as a passing run.
3. **A declared `junit-unit` is ignored by `unit`,** though the gate composes it as a suite.
4. **An empty selection is filed.** A `unit` run whose reports hold no case is filed. The `tier-selection-empty`
   refusal CR-CRU-267 settled for every stack is missing here.
5. **The help text and the RUNBOOK do not say how a tier is found.** The RUNBOOK has no arduino section.

## Behaviour

### S1: each tier verb runs its own place

The client translates the tier to where its tests run:

| Verb | Where | Runs |
|---|---|---|
| `unit` | `tests/native` | the native host tests |
| `integration` | `tests/sim` | tests under a simulator |
| `e2e` | `tests/hil` | tests on the board (HIL) |

- In each place the client runs `make junit`, as `unit` does today.
- `--dir` overrides the place, on each verb.
- `module` and `bdd` stay declared-only (S2).
- ArduinoFake tests stay a `unit --dir` choice.

### S2: a declaration wins

A declaration is a `junit-<tier>:` target in a Makefile. It runs in place of `make junit` and is filed under the tier.

- **Without `--dir`:** the client reads the Makefile under `tests/native`, where declarations live today and where the
  gate reads them. When `junit-<tier>` is declared there, it runs there. Otherwise `unit`, `integration` and `e2e` run
  `make junit` in their own place (S1).
- **With `--dir`:** only that directory's Makefile is read. `junit-<tier>` runs if it is declared there, otherwise
  `make junit` runs there.
- This now holds for `unit` too, so a declared `junit-unit` runs (Problem 3).
- **When neither is found:** `integration` with no `junit-integration` and no `tests/sim/Makefile`, `e2e` with no
  `junit-e2e` and no `tests/hil/Makefile`, and `module` or `bdd` with no declaration are refused with
  `tier-run-undeclared`. Nothing runs, and nothing reaches the board. The help names both ways out: declaring
  `junit-<tier>` in `tests/native/Makefile`, or adding the place's `Makefile` (`tests/sim/Makefile`,
  `tests/hil/Makefile`).

CR-CRU-211's scoping is kept:

- `--tests` and `--name` stay on `test` and `unit`. They reach `make` as `TESTS` and `TEST_NAME`, under a declared
  `junit-unit` as well.
- `TESTS` and `TEST_NAME` set in the shell never reach `make` on any verb.

### S3: no case run is refused, never filed

On `unit`, `integration` and `e2e`, the run is refused with `tier-selection-empty` when its reports hold no case, or
only skipped cases. This covers a board or simulator that never answered, and a narrowed run that matched nothing.

- The refusal exits 1 and files nothing.
- With `--agent`, the run it opened is aborted and the agent's identity closed, as a run that wrote no report is today.
- The message says no case ran, and that no board or simulator may have answered.
- A run in which at least one case ran is filed as today, whatever else was skipped.
- `regression` and `test` keep filing a run that found no case, as rust's do.

### S4: `regression` and the gate are unchanged

- `regression` runs `make junit` once under `--dir`.
- `pre-merge-gate` composes the targets declared under its `--dir` as today. A declared `junit-integration` joins it.
  A declared `junit-e2e` is excluded, with the fleet-wide sentence.
- A place found only by S1's convention never joins the gate.

### S5: one switch set

- The verbs and the refusal codes (`tier-run-undeclared`, `tier-selection-empty`) are CR-CRU-267's.
- Arduino takes no `--profile`; `--dir` is its selection override.
- Rust's and Maven's private tier-run refusal helpers become one shared helper in the shared client module. All three
  clients call it, and the two private copies are deleted.

### S6: help and docs

- The `unit`, `integration` and `e2e` help lines name their place, `--dir` and the `junit-<tier>` override.
- The root description names the three places.
- `docs/RUNBOOK.md` gains an "Arduino tier verbs" section beside "Maven tier verbs". It covers:
  - what each verb runs, declared and not;
  - the places and `--dir`;
  - both refusals;
  - the gate;
  - `module` and `bdd`;
  - the stream key of a declared target (`<dir>/junit-<tier>`).
- `CHANGELOG.md`'s `## [Unreleased]` gains one `### Changed` entry.

## Acceptance criteria

Each AC runs the client against a scratch firmware project with a stand-in `make` that records its argv and working
directory and writes JUnit reports, and a recording board. Each holds with and without `--agent`.

- [ ] **AC1 (S1, S2) — `unit`.**
  - With only `junit:` in `tests/native/Makefile`, `unit` runs `make junit` in `tests/native` and files under `unit`.
  - With `junit-unit:` added, it runs `make junit-unit`, never `make junit`, and files under `unit`.
  - `unit --tests test_a --name foo` under `junit-unit` hands `make` `TESTS=test_a` and `TEST_NAME=foo`.
- [ ] **AC2 (S1, S2) — `e2e` and `integration` by place.**
  - With `tests/hil/Makefile` present and no `junit-e2e` declared, `e2e` runs `make junit` in `tests/hil` and files
    under `e2e`.
  - With `tests/sim/Makefile` present, `integration` does the same in `tests/sim` and files under `integration`.
  - With `junit-e2e:` declared in `tests/native/Makefile`, `e2e` runs `make junit-e2e` in `tests/native`, even when
    `tests/hil/Makefile` exists.
  - `e2e --dir tests/rig` runs `make junit` in `tests/rig` when its Makefile declares no `junit-e2e`.
- [ ] **AC3 (S2) — refused when neither is found.**
  - With no `tests/hil/Makefile` and no `junit-e2e`, `e2e` answers `ok:false`, code `tier-run-undeclared`, exit 1.
    No `make` runs and nothing reaches the board.
  - Its `help[]` names `tests/hil/Makefile` and `junit-e2e`.
  - The same holds for `integration` with `tests/sim/Makefile` and `junit-integration`.
  - `module` and `bdd` with no declaration are refused the same way.
- [ ] **AC4 (S2) — CR-CRU-211's scoping.** With `TESTS` and `TEST_NAME` set in the client's environment, no `make` run
  by `unit`, `integration`, `e2e`, `module` or `bdd` receives either.
- [ ] **AC5 (S3) — no case run.**
  - Each of `unit`, `integration` and `e2e` answers `ok:false`, code `tier-selection-empty`, exit 1, and posts no run,
    in two cases:
    - when its reports hold only `<skipped>` cases;
    - when its reports hold no case.
  - With `--agent`, an abort of the opened run is recorded.
  - A narrowed `unit --name nomatch` that runs no case is refused the same way.
  - A run with one passed case and the rest skipped is filed.
  - `regression` with zero-case reports still files its run.
- [ ] **AC6 (S4) — what stays.**
  - `regression` runs `make junit` once in `--dir`.
  - With `junit-integration` and `junit-e2e` declared in `tests/native/Makefile`, `pre-merge-gate` composes
    `junit-integration` as a gated suite and `junit-e2e` as excluded.
  - With only `tests/hil/Makefile` and `tests/sim/Makefile` present, it composes neither.
- [ ] **AC7 (S5) — one shared refusal.** Rust's and Maven's existing tier-run refusal tests pass unchanged against the
  shared helper. Its non-test callers are `rust-crucible.py`, `mvn-crucible.py` and `arduino-crucible.py`, and neither
  private copy remains. VERIFY confirms by search.
- [ ] **AC8 (S6) — help and docs (reviewed, not tested).** The help lines and the root description say what S6 says.
  The RUNBOOK section and the CHANGELOG entry exist and match the behaviour. No test reads the RUNBOOK or the
  CHANGELOG.

## Tests

- **New:** one integration module named for the behaviour, for example
  `tests/client/integration/test_an_arduino_tier_verb_runs_host_or_target_tests.py`, for AC1–AC6. It spawns the
  stand-in `make` and a recording board.
- **Changes:**
  - In `test_client_tier_run_envelope.py`, the arduino zero-discovery case moves from `unit` to `regression`.
  - `test_client_tier_declaration_detection.py` keeps working, because its declarations pass `--dir tests/native`.
    Its refusal sentence must still name the `Makefile` and a `make junit-<tier>` example.
  - In `test_client_tier_run_modality.py`, arduino's split cells gain `integration` and `e2e`.
  - In `test_an_arduino_run_narrowed_by_tests_and_name_reaches_make.py`, `unit`'s zero-case runs, narrowed or not,
    expect AC5's refusal. `test` keeps today's behaviour, and the module's other tests hold.
- **Pins that hold as written:**
  - the arduino gate tests;
  - the arduino stream-declaration tests.

## Non-goals

- `--profile` on arduino.
- Per-tier `regression` or gate runs.
- A rig or simulator check before the build, or any `crucible.toml` table for a rig.
- Driving a particular simulator or rig vendor.
- ArduinoFake's tier, beyond `unit --dir`.
- Telling what a `--dir` holds: `unit --dir tests/hil` still files under `unit`.
- Hermetic hardware tiers, which are CR-CRU-270's to decide.
- Model B's agent and skill wording.

## Rulings (2026-11-24)

From the gap analysis, ruled by the user:

1. HIL is `e2e` and simulation is `integration`.
2. Each is found by a directory convention (`tests/hil`, `tests/sim`), and a declared `junit-<tier>` wins.
3. A run with no case, or only skipped cases, is refused with `tier-selection-empty` on `unit`, `integration` and
   `e2e`. `regression` still files a zero-case run.
4. `module` and `bdd` stay declared-only.
5. `regression` and the gate are unchanged.
6. Rust's and Maven's private tier-run refusal helpers become one shared helper.

Set by Mainline within those rulings, and approved with this spec:

- A declaration is read where it is today: under `--dir`, defaulting to `tests/native`.
- S3 also refuses a narrowed `unit` run that ran nothing, as rust's narrowed filter does.

## Close-out (2026-11-25)

Plan 276.

- **Cycle 1025, RED/GREEN.**
  - **RED.**
    - A new integration module, `tests/client/integration/test_an_arduino_tier_verb_runs_host_or_target_tests.py`,
      covers AC1–AC6, each with and without `--agent`.
    - Three modules changed as the Tests section says.
    - The Tests section first listed the narrowed-run module as a pin. Its `unit` zero-case tests contradicted AC5, so
      they now follow AC5, and the section was corrected.
  - **GREEN.**
    - Arduino's place resolution (`_resolve_tier_place`, `_run_tier_place`).
    - The refusal of a run with no case (`_refuse_no_case_run`).
    - The shared `refuse_tier_run` in `clients/_crucible_axi.py`, now called by rust, maven and arduino.
    - The help text, the RUNBOOK's "Arduino tier verbs" section and the CHANGELOG entry.
- **Cycle 1026, VERIFY:** PASS, with two should-fix items and three notes.
- **Cycle 1027, FIX.**
  - The `module` and `bdd` refusals list only the tiers that run on the project.
  - The `integration` and `e2e` refusals name `tests/native/Makefile`, or `--dir`'s Makefile.
  - One shared `UNFILED_RUN`.
  - The RED docstrings were reworded as pins.
  - The empty-run assertions also check the message and the agent's sign-off.
  - Each tightened test was shown failing without its fix.
- **Pre-merge gate (cycle 1027):** 13,479 passed and 0 failed in about 24 minutes, with the unit-check stage clean
  first. By suite: bun 5,076, python unit 2,624, python integration 5,779.
- **For CR-CRU-270:** the hardware tiers are `e2e` (HIL, `tests/hil`) and `integration` (simulation, `tests/sim`).
  Whether they can run hermetically is CR-CRU-270's question.
