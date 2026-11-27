# CR-CRU-242 — an EDA project runs a pytest tier and files it

**Status:** PENDING · revised after gap analysis and user rulings (2026-11-27)
**Type:** feature
**Priority:** high. P1's first hardware CR (CR-PFC-010) and Model B's CR-MDB-102 wait on it.
**Depends on:** CR-CRU-241
**Labels:** clients, eda
**Phase:** design
**Design reference:** `docs/research/DN-testing-tiers-in-crucible-projects.md` (the project classifies; the gate covers every declared suite); CR-CRU-196 (per-tier gate suites); CR-CRU-197 (pytest outcomes); CR-CRU-241 (the shared pytest path)

## Context

An electronics project (SKiDL, KiCad, Perfboard Studio, ngspice) writes its gates as pytest suites, and
nothing can file them to the board. Today there is no electronics client: P1's hardware CR registers its
agents through the arduino client, for liveness only, and its gate results go unrecorded.

- **Model B's stack needs two things.** Model B is adding the stack as CR-MDB-102. It needs a client and
  a pass, fail or SKIP verdict per gate and per tier in the envelope.
- **Perfboard Studio needs Python 3.12–3.13.** The gates must therefore run under the project's own venv
  interpreter, never under the client's own (≥ 3.14).

This CR is the client's behaviour. CR-CRU-243 installs it, declares it in the schema, and counts it in the fleet.

CR-CRU-241 put the pytest pieces in the shared run module. The python client still holds two compositions of
them inline: the routing of a finished pytest run (file the JUnit, or a compile record, or abort as ran-nothing)
and the passing-subtest watch. This CR lifts both first (§S0), so the eda client copies none of python's code.

## Scope

- **One client, stack `eda`:** `clients/eda-crucible.py`. Each project declares its tiers in its own
  `crucible.toml`.
- **The tiers run pytest with JUnit,** through the shared pytest path, in the project's interpreter. A gate
  that cannot run yet calls `pytest.skip`. Its JUnit `<skipped>` is stored as `pending`, which is a SKIP and
  never red.
- **One run per declared entry.** An entry is `[targets."<tier>"]` or `[targets."<tier>/<label>"]`, so a
  tier may hold several entries. The tier is the key's first segment, and must be one of `unit`, `module`,
  `integration`, `e2e` or `bdd`.
- **No board field is added.** Counts that a gate asserts (ERC, LVS, opens and shorts) appear only in its
  failure message.
- **The board shows an eda-pytest run grouped by class,** as it does a pytest run (§S8).
- **The interpreter is never the client's own.** With none declared and no `.venv`, the run is refused.
- **The project dir is the eda sub-project.** For P1 it is `hardware/`, which holds the declaration, the
  `.env` with the key, and a `.venv` on Python 3.13. Because P1's git repo is its root, P1 names
  `hardware/` with `--project-dir` or `$EDA_CRUCIBLE_PROJECT_DIR` (documented by CR-CRU-243).
- **Every pytest child runs headless,** the import probe included. Its environment has
  `QT_QPA_PLATFORM=offscreen`, and `DISPLAY` and `WAYLAND_DISPLAY` removed, so no tool a gate drives can open a
  window. Children that run no project code (such as `git`) are not covered.
- **A project's own tests are the project's.** "The client parses no report" binds the client, not a
  project's tests. An eda-pytest test may read committed project files, such as a `.perf` and its captured
  results (CR-CRU-246), and may start `perfboard-studio-mcp` on a `/tmp` copy, for example for mutation tests.
- **The client carries no L0–L3 table.** The mapping (L1 → `unit`, L1b → `module`, L2 → `integration`,
  L3 → `e2e`) is documentation (CR-CRU-243). The client reads tier names only from the declaration keys.
- **Verdicts ride the envelope.** The run's counts come from the board's answer, so the client parses no
  report. SKIP reasons are read from pytest's console.
  - **Measured on pytest 9.1.1 and 9.2.0:** a `-v` line is `<nodeid> SKIPPED (<reason>)     [ 50%]`, with
    the reason cut to the terminal width.
  - **So the pytest child runs with a wide `COLUMNS`.** `-rs` gives the full reason but no node id, and it
    folds identical skips, so it is not used.

### §S0 — the shared pieces this CR lifts first

Into `clients/_crucible_run.py`, standard library only, each a public name the clients reach through the core:

- **The routing of a finished pytest run.** Given the runner's exit, its output and the reports dir, it does what
  python's `_test_run` and `_regression_run` do inline today:
  - files the JUnit when one was produced and pytest did not fail as a runner (exits 0, 1, 2);
  - files a compile record carrying `pytest_error_line` when pytest failed as a runner (exits 3, 4);
  - aborts the run as ran-nothing (`no-test-reports`) when no report was produced (exit 5, a signal).
- **The passing-subtest watch:** the composition of `pytest_reports_passing_subtest` and
  `PYTEST_SUBTESTS_UNCOUNTED_DETAIL` that python's `_FallbackWatch` holds, giving the `subtests-uncounted`
  warning.
- **A headless environment for the import probe:** `pytest_importable` takes an optional `env`, used for the
  probe's child; without one it behaves as today.
- **A labelled key's tier.** The shared reader of a declared key's tier answers the first segment of
  `<tier>/<label>` for a stack whose keys take a label (eda), so a labelled `e2e` entry is excluded from the gate
  like `e2e`. Every other stack's keys are read as today.

The python client switches to the routing and the subtest watch, and keeps its behaviour byte for byte: the same
argv, narration, warnings, exits, records and refusals.

### §S1 — the client and its fleet surface

- **`clients/eda-crucible.py`** sets `_STACK = "eda"` and offers these verbs, all through the shared
  `_crucible_axi` and `_crucible_run` modules and with the fleet's envelopes:
  - `register` and `unregister`;
  - `test`;
  - `unit`, `module`, `integration`, `e2e` and `bdd`, through the shared `add_tier_verbs`;
  - `regression` and `pre-merge-gate`;
  - `auto-ingest`, `status`, the plan, cycle and roadmap verbs, `gate-run`, `gate-report` and `milestone`.
- **The fleet invariants hold:**
  - every verb that runs tests takes `--hermetic` (the shared `add_hermetic_arg`);
  - each is refused while the agent's cycle is active elsewhere, before an interpreter is spawned;
  - `unit` carries the shared wall-vs-CPU warning;
  - a run whose output shows passing subtests carries `subtests-uncounted`.
- **No verb takes `--coverage`.** There is no `lint` verb, and the gate runs no lint or unit-check stage (a
  later CR). There is no `check` verb (CR-CRU-245), `drc` verb (CR-CRU-248) or `sim` verb (CR-CRU-249).

### §S2 — the project, its key and its interpreter

- **The project dir:** `--project-dir` > `$EDA_CRUCIBLE_PROJECT_DIR` > the git repo of the working
  directory > the working directory.
- **The key:** `CRUCIBLE_PROJECT_KEY` is read from `<project-dir>/.env` only. It is never read from a
  parent directory. A missing key is refused the fleet's way, naming `<project-dir>/.env`.
- **The interpreter:** `--python` > `$EDA_CRUCIBLE_PYTHON` > `[eda] python` in the project's
  `crucible.toml` (relative to the project dir) > `<project-dir>/.venv/bin/python` > **refused**.
  - The refusal names every candidate it tried.
  - The client's own `sys.executable` is never used.
- **The pytest check:** the interpreter must import pytest (the shared `pytest_importable`, given the headless
  environment). `False` is refused, naming the interpreter and that it needs pytest. `None` (no answer in
  time) is refused, naming the interpreter and the timeout (`pytest_probe_timeout()`).
- **When the refusals happen:** every refusal in this section comes before anything is posted to the
  board. The interpreter and pytest refusals carry `ok: false` and exit 1.

### §S3 — the declaration

The declaration is read from `<project-dir>/crucible.toml`.

- **An eda entry** is a `[targets."<key>"]` table whose `framework` is `"eda-pytest"`. Its `paths` is a
  non-empty list of strings. Each string is a path relative to the project dir, or such a path followed by
  `::<node id>`, and the file or directory part must exist. Any other field is accepted and ignored: the
  entry is open.
- **The key form** is `<tier>` or `<tier>/<label>`, where `<label>` is non-empty.
- **Another stack's entry is skipped,** decided on `framework` before any other field is checked: a reserved
  framework of another stack (`_OTHER_STACKS_FRAMEWORKS`, from the schema), or no `framework` at all (an entry
  without one is rust's).
- **What is refused,** with `DeclarationRefused`, naming the table, the field and the file:
  - a `framework` that no stack reserves (the fleet's reader rule);
  - an eda entry whose key's tier is not one of the five, or whose label is empty;
  - a `paths` that is missing, empty or not a list of strings, or that names a missing file;
  - an `[eda] python` that is not an executable file;
  - a `crucible.toml` that does not parse.
- **An absent file, or no eda entry,** declares nothing.

### §S4 — the runs

- **A tier verb** runs every entry of its tier, in key order, each as its own run.
  - Each run is one pytest invocation over that entry's `paths`, through the shared `pytest_command`.
  - It is filed under the tier, with `codec: junit` and `framework: eda-pytest`.
  - Every entry runs, whatever an earlier one's outcome. A SIGTERM ends the verb after the current entry's run is
    left aborted; later entries do not run.
  - The verb writes one envelope (§S5) and exits 1 when its `verdict` is `fail`, else 0.
  - `--entry <key>` narrows the verb to one entry. A key outside the tier, or not declared, is refused with no
    run opened.
  - A tier with no entry raises the shared `TierRunUndeclared`, and its help names
    `[targets."<tier>"]` with `framework = "eda-pytest"`.
- **`regression`** is one pytest run over the union of every eda-pytest entry's `paths`, `e2e`
  included. Each path is passed once. The run is filed under `regression`. With no entry declared, it is
  refused, naming the declaration.
- **`test --tests <path or node id> …`** is one pytest run with no tier. Without `--tests` it is refused,
  naming the tier verbs.
- **Every pytest run** sets `COLUMNS` to `EDA_PYTEST_COLUMNS`, a named constant of at least 1000, in the
  child's environment, and makes the child headless (Scope). Its outcomes are §S0's shared routing:
  - exits 0, 1 and 2 file the JUnit (a collection error is one failed test);
  - exit 5 aborts the run with `no-test-reports`;
  - exits 3 and 4 file a compile record carrying `pytest_error_line`, with no tests;
  - a SIGTERM leaves the run aborted, with one envelope.
- **The verbs that run tests** carry these flags: `--agent`, `--cycle`, `--release`, `--reports`,
  `--log`, `--project-dir`, `--python` and `--hermetic`.

### §S5 — verdicts and skips in the envelope

- **Every run's envelope carries `verdict`:**
  - `fail` when the run was not filed with counts (aborted, ran nothing, the board refused it or could not be
    reached), when it was filed through the compile path, or when its filed `failed > 0`;
  - `skip` when its filed `passed == 0`, `failed == 0` and `pending > 0`;
  - `pass` otherwise.
- **A tier verb's envelope** is one document for all its entries:
  - `entries[]`, one per entry run: `{key, verdict, passed, failed, pending, event}`;
  - `run`, the sum of the entries' counts, and `events[]`, every entry's event;
  - its own `verdict`: `fail` if any entry fails, `skip` if every entry is a skip, `pass` otherwise.
- **A `skip` verdict** adds the warning `{code: "tier-skipped", detail: "<key>: all <N> tests skipped"}`.
- **`skipped[]`** lists `{test: <node id>, reason}` for each `SKIPPED` line in pytest's `-v` output.
  - The reason is the text inside the line's last parenthesised group before the progress marker. When
    there is none, `reason` is `null`.
  - The list holds at most `SKIPPED_LIST_LIMIT` (20) entries, and `skippedNotListed` states how many
    were left out.
- **`regression`** carries one `verdict` for its single run. Per-tier verdicts come from the tier verbs
  and the gate.

### §S6 — the gate

`pre-merge-gate` composes through the shared `gate_regression`, after the shared
`refuse_unrunnable_scoped_gate`:

- **Its declared suites** are one per eda entry, read as `(target, command, framework)` like every other
  client's: `target` is the entry key and `framework` is `eda-pytest`; the shared code derives the tier.
  `run_suite` runs one entry as §S4 does, and `whole_framework` is `None`.
- **So every entry is its own suite and row,** and the whole-suite run is skipped (the shared fourth rule).
  `e2e` and `e2e/<label>` entries are listed and excluded.
- **Each skipped tier is named.** A suite's `tier-skipped` warning reaches the gate envelope through the
  shared adoption of suite warnings.
- **`--suites <key>[,<key>]`** scopes the gate to those entries. A key that is not declared is refused
  before anything runs.
- **With no eda entry,** the gate is refused, naming the declaration.

### §S7 — the census

The fleet's enumerations of `clients/*-crucible.py` that would move or break when the file appears:

- `tests/unit/queue-seq-finding-cause.test.ts`, which pins the client count and list (six today): it counts
  seven, eda included;
- `test_client_tier_verb_contract.py`'s glob: eda meets the tier-verb contract it checks;
- `test_client_limits_resolve_from_configuration.py`'s glob: eda resolves its limits from configuration.

### §S8 — the board groups an eda-pytest run by class

The JUnit codec (`src/codecs/junit.ts`) groups a pytest run's cases by class when its single suite is named
`pytest`. It does the same for `eda-pytest`, whose argv is the shared pytest argv. Every other framework's tree
is unchanged.

## Acceptance criteria

All of these run on a committed fixture project, copied to a scratch dir per run. It has its own interpreter
with pytest (built once per test class, distinct from the suite's own `sys.executable`), and these entries:

- `[targets."unit"]` over `tests/unit`: 2 tests pass, 1 fails, 1 calls `pytest.skip("board not
  populated")`;
- `[targets."integration/net"]` over `tests/integ`;
- `[targets."e2e"]` over `tests/bench`, where every test is skipped.

The fixture's test files are not collected by this repo's own discovery.

- [ ] **AC0 — the lift (§S0).**
  - The shared routing files exits 0/1/2, records exits 3/4 with the error line, and aborts exit 5 and a
    signal as ran-nothing, each asserted through a client run.
  - The shared subtest watch gives `subtests-uncounted` for output with passing subtests, and nothing otherwise.
  - `pytest_importable(python, cwd, env=…)` runs the probe with that environment (recorded by a stub
    interpreter); without `env` it is unchanged.
  - A labelled eda key's tier is its first segment; other stacks' keys read as before.
  - The python client's existing suites (CR-CRU-241's AC7 set and the `test_a_pytest_*` suites) pass unedited.
- [ ] **AC1 — one entry, one run.** `eda-crucible.py unit --agent <id>`:
  - opens one run with `tier: unit`, `stack: eda`, `codec: junit` and `framework: eda-pytest`;
  - is filed with passed 2, failed 1 and pending 1;
  - files no case from `tests/integ`;
  - exits 1;
  - carries `verdict: fail`.
- [ ] **AC2 — a tier with several entries.**
  - **Setup:** add `[targets."integration/sim"]` over `tests/sim`, all skipped.
  - `integration --agent <id>` opens two runs under `integration`, one per entry, in key order, and writes one
    envelope.
  - `entries[]` holds both; `run` sums them; `events[]` holds both events.
  - With `integration/net` failing and `integration/sim` all skipped, the tier `verdict` is `fail`, both
    entries ran, and the `tier-skipped` warning names `integration/sim`.
  - `--entry integration/net` opens one. `--entry unit` and `--entry integration/nosuch` are refused, with no
    run opened.
- [ ] **AC3 — the declaration.**
  - On a copy with no `module` entry, `module --agent <id>` exits non-zero with `ok: false`, has help that names
    `[targets."module"]` and `eda-pytest`, opens no run and runs no pytest.
  - `regression` and `pre-merge-gate` on a copy with no eda entry are refused the same way.
  - An entry with no `framework`, and one with another stack's framework, are skipped.
  - An unknown framework, an empty label, an empty `paths`, a missing path, and a `crucible.toml` that does
    not parse are each refused, naming the table, field and file.
- [ ] **AC4 — the interpreter.**
  - **Nothing resolves:** with no flag, no environment variable, no `[eda] python` and no `.venv`, the run
    is refused before any POST (the test's stub board records none). The envelope names all four
    candidates.
  - **Each source wins in turn:** `.venv`, then `[eda] python`, then `$EDA_CRUCIBLE_PYTHON`, then
    `--python`. Each is asserted from the spawned argv's first element.
  - **`sys.executable` never appears** in any spawned argv.
  - **An interpreter without pytest** is refused before any POST, naming it.
  - **An interpreter that does not answer in time** (the probe timeout patched short) is refused, naming the
    timeout.
  - **An `[eda] python` that is not executable** is refused.
- [ ] **AC5 — the sub-project.**
  - `--project-dir <fixture>/hardware` with no `CRUCIBLE_PROJECT_KEY` in `hardware/.env` is refused,
    naming `hardware/.env`, even when the parent's `.env` holds a key.
  - With the key, it reads `hardware/crucible.toml`.
- [ ] **AC6 — the SKIP list.**
  - `unit`'s envelope carries `skipped: [{test: "tests/unit/<file>::<test>", reason: "board not
    populated"}]`.
  - A skip whose reason is 240 characters long arrives whole.
  - With 25 skips, 20 are listed and `skippedNotListed` is 5. With no skip, `skipped` is empty.
  - The spawned environment holds `COLUMNS=<EDA_PYTEST_COLUMNS>`.
- [ ] **AC7 — the SKIP verdict.**
  - `e2e --agent <id>` exits 0, with `verdict: skip` and a `tier-skipped` warning naming `e2e`.
  - The board's run has pending equal to its total.
- [ ] **AC8 — every pytest exit path.** On the fixture, each of these gives §S0's shared outcome, on a tier
  verb and on `regression`:
  - a collection error (exit 2);
  - a missing node id and a broken `conftest.py` (exit 4), and an internal error (exit 3);
  - an empty entry (exit 5), whose verdict is `fail`;
  - a SIGTERM.
- [ ] **AC9 — `regression`.** One run under `regression` holds every test of the three entries once.
- [ ] **AC10 — the gate.** `pre-merge-gate` on the fixture plus `integration/sim` and an `e2e/bench` entry:
  - gives `suites[]` rows `unit`, `integration/net` and `integration/sim`, each with
    `client: eda-crucible.py` and its own run, counts (`pending` included) and outcome;
  - lists `e2e` and `e2e/bench` as excluded;
  - has a `whole-suite skipped` statement, and no whole-suite run.

  A failing `integration/net` fails only its row. A row whose tests are all skipped puts its
  `tier-skipped` warning in the gate's `warnings`. `--suites unit` is scoped, and `--suites nosuch` is
  refused before any run.
- [ ] **AC11 — the fleet invariants.**
  - The tier verbs, `test`, `regression` and `pre-merge-gate` take `--hermetic`, and a hermetic run behaves as
    every other client's (the fleet's hermetic suite covers eda).
  - Each is refused while a cycle is active elsewhere, before an interpreter is spawned.
  - `unit` carries the wall-vs-CPU warning when its run's wall time outruns its CPU time as the fleet's does.
  - A run whose tests pass subtests carries `subtests-uncounted`.
- [ ] **AC12 — the census.** `tests/unit/queue-seq-finding-cause.test.ts` counts seven clients, eda included, and
  the tier-verb-contract and limits suites cover eda.
- [ ] **AC13 — headless children.** A fixture test that writes its own `QT_QPA_PLATFORM`, `DISPLAY` and
  `WAYLAND_DISPLAY` into a file is run by `unit` with `DISPLAY` and `WAYLAND_DISPLAY` set in the client's
  own environment. The file reads `offscreen`, unset and unset. The same holds for `test`, `regression` and the
  gate's suites, and the probe's recorded environment is headless too.
- [ ] **AC14 — the board's tree.** An `eda-pytest` JUnit run with cases in two classes is shown as two class
  groups, as the same run under `pytest` is; a run of any other framework keeps its tree.

### Reviewed, not tested

- The routing and the subtest watch are defined once, in `_crucible_run.py`; neither python nor eda keeps a copy.
- `_crucible_run.py` imports only the standard library.
- `eda-crucible.py` imports no XML parser and holds no string-keyed tier literal; every test-running verb calls
  the one interpreter resolver and the shared `pytest_command`.
- No CR id or AC label in any added line under `clients/`, `src/` or `tests/`.

## Estimated size

13 points (re-scored from 8 at the gap analysis). The fleet surface comes through the shared modules and the
pytest path from CR-CRU-241. The new parts are:

- the lift of the routing, the subtest watch, the probe's environment and the labelled tier (§S0);
- the interpreter and key resolution;
- the declaration reader;
- runs per entry and the tier verb's one envelope;
- the verdict and the skip list;
- the gate's suites;
- the census and the board's grouping.

## Risk

- **A wider `COLUMNS` lengthens every `-v` line.** Only the console log is affected; the board's record is
  the JUnit.
- **`-v` wording may change.** A pytest release that stops printing `SKIPPED (<reason>)` gives
  `reason: null`, and the verdict is unaffected. So does an operator's `PYTEST_ADDOPTS=-q`.
- **The interim on develop.** Between this CR's merge and CR-CRU-243's, the schema does not name eda. Until
  CR-CRU-243 adds `eda-pytest` to their skip sets, a project mixing rust, arduino or maven `[targets]` with eda
  entries would see those clients refuse the eda entries. The wave releases only after CR-CRU-243.
- **The lift touches the python client's pytest path again.** Its behaviour is pinned by CR-CRU-241's suites,
  which pass unedited.

## Non-goals

- Installing the client, the schema entry, the skip sets of the other clients, the help-text census and the docs
  (CR-CRU-243).
- A `lint` verb, and the gate's lint and unit-check stages (a later CR).
- `check` (CR-CRU-245), `drc` (CR-CRU-248), `sim` (CR-CRU-249) and gate scripts (CR-CRU-244).
- Coverage on any verb.
- A board field for ERC, DRC or LVS counts, open and short counts, or measured values.
- Pinning a Python version.
- Per-board venvs.
- Launching or detecting a GUI.
- A parent-directory `.env` lookup.
- The `crucible-report-eda` skill, which is Model B's.
- P1's own files.
- The Build step, which files nothing.
