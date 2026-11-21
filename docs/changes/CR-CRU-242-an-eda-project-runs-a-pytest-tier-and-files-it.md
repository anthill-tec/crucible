# CR-CRU-242 — an EDA project runs a pytest tier and files it

**Status:** PENDING · Pre-review: due — 8 points, user rulings, another project's surface
**Type:** feature
**Priority:** high. P1's first hardware CR (CR-PFC-010) and Model B's CR-MDB-102 wait on it.
**Depends on:** CR-CRU-241
**Labels:** clients, eda
**Phase:** design
**Design reference:** `docs/research/DN-testing-tiers-in-crucible-projects.md` (the project classifies; the gate covers every declared suite); CR-CRU-196 (per-tier gate suites); CR-CRU-197 (pytest outcomes)

## Context

An electronics project (SKiDL, KiCad, Perfboard Studio, ngspice) writes its gates as pytest suites, and
nothing can file them to the board. Today there is no electronics client: P1's hardware CR registers its
agents through the arduino client, for liveness only, and its gate results go unrecorded.

- **Model B's stack needs two things.** Model B is adding the stack as CR-MDB-102. It needs a client and
  a pass, fail or SKIP verdict per gate and per tier in the envelope.
- **Perfboard Studio needs Python 3.12–3.13.** The gates must therefore run under the project's own venv
  interpreter, never under the client's own (≥ 3.14).

This CR is the client's behaviour. CR-CRU-243 installs it, declares it in the schema, and counts it in the fleet.

## Scope

- **One client, stack `eda`:** `clients/eda-crucible.py`. Each project declares its tiers in its own
  `crucible.toml`.
- **The tiers run pytest with JUnit,** through the shared pytest path (CR-CRU-241), in the project's
  interpreter. A gate that cannot run yet calls `pytest.skip`. Its JUnit `<skipped>` is stored as
  `pending`, which is a SKIP and never red.
- **One run per declared entry.** An entry is `[targets."<tier>"]` or `[targets."<tier>/<label>"]`, so a
  tier may hold several entries. The tier is the key's first segment, and must be one of `unit`, `module`,
  `integration`, `e2e` or `bdd`.
- **No board field is added.** Counts that a gate asserts (ERC, LVS, opens and shorts) appear only in its
  failure message.
- **The interpreter is never the client's own.** With none declared and no `.venv`, the run is refused.
- **The project dir is the eda sub-project.** For P1 it is `hardware/`, which holds the declaration, the
  `.env` with the key, and a `.venv` on Python 3.13.
- **Every child the client starts runs headless.** Its environment has `QT_QPA_PLATFORM=offscreen`, and
  `DISPLAY` and `WAYLAND_DISPLAY` removed, so no tool a gate drives can open a window.
- **A project's own tests are the project's.** "The client parses no report" binds the client, not a
  project's tests. An eda-pytest test may read committed project files, such as a `.perf` and its captured
  results (CR-CRU-246), and may start `perfboard-studio-mcp` on a `/tmp` copy, for example for mutation tests.
- **The client carries no L0–L3 table.** The mapping (L1 → `unit`, L1b → `module`, L2 → `integration`,
  L3 → `e2e`) is documentation (CR-CRU-243). The client reads tier names only from the declaration keys.
- **Verdicts ride the envelope.** The run's counts come from the board's answer, so the client parses no
  report. SKIP reasons are read from pytest's console.
  - **Measured on pytest 9.2.0:** a `-v` line is `<nodeid> SKIPPED (<reason>)     [ 50%]`, with the reason
    cut to the terminal width.
  - **So the pytest child runs with a wide `COLUMNS`.** `-rs` gives the full reason but no node id, and it
    folds identical skips, so it is not used.

### §S1 — the client and its fleet surface

- **`clients/eda-crucible.py`** sets `_STACK = "eda"` and offers these verbs, all through the shared
  `_crucible_axi` and `_crucible_run` modules and with the fleet's envelopes:
  - `register` and `unregister`;
  - `test`;
  - `unit`, `module`, `integration`, `e2e` and `bdd`;
  - `regression` and `pre-merge-gate`;
  - `auto-ingest`, `status`, the plan, cycle and roadmap verbs, `gate-run`, `gate-report` and `milestone`.
- **No verb takes `--coverage`.** There is no `check` verb (CR-CRU-245), `drc` verb (CR-CRU-248) or `sim` verb (CR-CRU-249).

### §S2 — the project, its key and its interpreter

- **The project dir:** `--project-dir` > `$EDA_CRUCIBLE_PROJECT_DIR` > the git repo of the working
  directory > the working directory.
- **The key:** `CRUCIBLE_PROJECT_KEY` is read from `<project-dir>/.env` only. It is never read from a
  parent directory.
- **The interpreter:** `--python` > `$EDA_CRUCIBLE_PYTHON` > `[eda] python` in the project's
  `crucible.toml` (relative to the project dir) > `<project-dir>/.venv/bin/python` > **refused**.
  - The refusal names every candidate it tried.
  - The client's own `sys.executable` is never used.
- **The pytest check:** the interpreter must import pytest (the shared `pytest_importable`). `False` or
  `None` is refused, naming the interpreter, and that it needs pytest.
- **When the refusals happen:** every refusal in this section comes before anything is posted to the
  board, with `ok: false` and exit 1.

### §S3 — the declaration

The declaration is read from `<project-dir>/crucible.toml`.

- **An eda entry** is a `[targets."<key>"]` table whose `framework` is `"eda-pytest"`. Its `paths` is a
  non-empty list of strings. Each string is a path relative to the project dir, or such a path followed by
  `::<node id>`, and the file or directory part must exist. Any other field is accepted and ignored: the
  entry is open.
- **The key form** is `<tier>` or `<tier>/<label>`, where `<label>` is non-empty.
- **Another stack's framework** is skipped, decided on `framework` before any other field is checked.
  `_OTHER_STACKS_FRAMEWORKS` lists every other stack's reserved framework, from the schema.
- **What is refused,** with `DeclarationRefused`, naming the table, the field and the file:
  - an entry with an eda framework whose key's tier is not one of the five;
  - a `paths` that is missing, empty or not a list of strings, or that names a missing file;
  - an `[eda] python` that is not an executable file;
  - a `crucible.toml` that does not parse.
- **An absent file, or no eda entry,** declares nothing.

### §S4 — the runs

- **A tier verb** runs every entry of its tier, in key order, each as its own run.
  - Each run is one pytest invocation over that entry's `paths`, through the shared `pytest_command`.
  - It is filed under the tier, with `codec: junit` and `framework: eda-pytest`.
  - `--entry <key>` narrows the verb to one entry. A key outside the tier is refused.
  - A tier with no entry raises the shared `TierRunUndeclared`, and its help names
    `[targets."<tier>"]` with `framework = "eda-pytest"`.
- **`regression`** is one pytest run over the union of every eda-pytest entry's `paths`, `e2e`
  included. Each path is passed once. The run is filed under `regression`. With no entry declared, it is
  refused, naming the declaration.
- **`test --tests <path or node id> …`** is one pytest run with no tier. Without `--tests` it is refused,
  naming the tier verbs.
- **Every pytest run** sets `COLUMNS` to `EDA_PYTEST_COLUMNS`, a named constant of at least 1000, in the
  child's environment, and makes the child headless (this Scope's opening). Its outcomes are the shared ones:
  - exits 0, 1 and 2 file the JUnit (a collection error is one failed test);
  - exit 5 aborts the run with `no-test-reports`;
  - exits 3 and 4 file a compile record carrying `pytest_error_line`, with no tests;
  - a SIGTERM leaves the run aborted, with one envelope.
- **The verbs that run tests** carry these flags: `--agent`, `--cycle`, `--release`, `--reports`,
  `--log`, `--project-dir` and `--python`.

### §S5 — verdicts and skips in the envelope

- **Every run's envelope carries `verdict`.** It is read from the board's filed counts (`filed_run`):
  - `fail` when `failed > 0`, or when the run was filed through the compile path;
  - `skip` when `passed == 0`, `failed == 0` and `pending > 0`;
  - `pass` otherwise.
- **A tier verb's envelope** also carries `entries[]`, one per entry: `{key, verdict, passed, failed,
  pending}`. Its own `verdict` is:
  - `fail` if any entry fails;
  - `skip` if every entry is a skip;
  - `pass` otherwise.
- **A `skip` verdict** adds the warning `{code: "tier-skipped", detail: "<key>: all <N> tests skipped"}`.
- **`skipped[]`** lists `{test: <node id>, reason}` for each `SKIPPED` line in pytest's `-v` output.
  - The reason is the text inside the line's last parenthesised group before the progress marker. When
    there is none, `reason` is `null`.
  - The list holds at most `SKIPPED_LIST_LIMIT` (20) entries, and `skippedNotListed` states how many
    were left out.
- **`regression`** carries one `verdict` for its single run. Per-tier verdicts come from the tier verbs
  and the gate.

### §S6 — the gate

`pre-merge-gate` composes through the shared `gate_regression`:

- **Its declared suites** are one `GateSuite` per eda entry. `target` is the entry key, `tier` is its
  tier, `framework` is `eda-pytest`, and `run_suite` runs that entry as §S4 does. `whole_framework` is
  `None`.
- **So every entry is its own suite and row,** and the whole-suite run is skipped (the shared fourth rule).
  `e2e` entries are listed and excluded.
- **Each skipped tier is named.** A suite's `tier-skipped` warning reaches the gate envelope through the
  shared adoption of suite warnings.
- **`--suites <key>[,<key>]`** scopes the gate to those entries. A key that is not declared is refused
  before anything runs.
- **With no eda entry,** the gate is refused, naming the declaration.

### §S7 — the [glob] census

The censuses that enumerate `clients/*-crucible.py` and pin a count move when the file appears:

- `tests/queue-seq-finding-cause.test.ts` (its length and sorted list);
- `test_client_unit_tier_wall_vs_cpu.py` `_tier_verb_clients`;
- the [glob] sites of `test_client_tier_run_envelope.py`;
- `test_client_tier_declaration_detection.py` `CLIENT_FILES`;
- `test_client_tier_verb_contract.py`;
- `test_cr098_resolver_lands_on_the_server.py`;
- the [glob] site of `test_client_limits_resolve_from_configuration.py`.

The eda client meets each contract that these enumerate.

## Acceptance criteria

All of these run on a committed fixture project, copied to a scratch dir per run. It has its own venv
interpreter with pytest, and these entries:

- `[targets."unit"]` over `tests/unit`: 2 tests pass, 1 fails, 1 calls `pytest.skip("board not
  populated")`;
- `[targets."integration/net"]` over `tests/integ`;
- `[targets."e2e"]` over `tests/bench`, where every test is skipped.

- [ ] **AC1 — one entry, one run.** `eda-crucible.py unit --agent <id>`:
  - opens one run with `tier: unit`, `stack: eda`, `codec: junit` and `framework: eda-pytest`;
  - is filed with passed 2, failed 1 and pending 1;
  - files no case from `tests/integ`;
  - exits 1;
  - carries `verdict: fail`.
- [ ] **AC2 — a tier with several entries.**
  - **Setup:** add `[targets."integration/sim"]` over `tests/sim`.
  - `integration --agent <id>` opens two runs under `integration`, one per entry, in key order.
  - `entries[]` holds both, and the tier `verdict` follows §S5.
  - `--entry integration/net` opens one.
  - `--entry unit` is refused, with no run opened.
- [ ] **AC3 — undeclared is refused.** On a copy with no `module` entry, `module --agent <id>`:
  - exits non-zero with `ok: false`;
  - has help that names `[targets."module"]` and `eda-pytest`;
  - opens no run and runs no pytest.

  `regression` and `pre-merge-gate` on a copy with no eda entry are refused the same way.
- [ ] **AC4 — the interpreter.**
  - **Nothing resolves:** with no flag, no environment variable, no `[eda] python` and no `.venv`, the run
    is refused before any POST (the test's stub board records none). The envelope names all four
    candidates.
  - **Each source wins in turn:** `.venv`, then `[eda] python`, then `$EDA_CRUCIBLE_PYTHON`, then
    `--python`. Each is asserted from the spawned argv's first element.
  - **`sys.executable` never appears** in any spawned argv.
  - **An interpreter without pytest** is refused before any POST, naming it.
- [ ] **AC5 — the sub-project.**
  - `--project-dir <fixture>/hardware` with no `CRUCIBLE_PROJECT_KEY` in `hardware/.env` is refused,
    naming `hardware/.env`, even when the parent's `.env` holds a key.
  - With the key, it reads `hardware/crucible.toml`.
- [ ] **AC6 — the SKIP list.**
  - `unit`'s envelope carries `skipped: [{test: "tests/unit/test_x.py::test_bench", reason: "board not
    populated"}]`.
  - A skip whose reason is 240 characters long arrives whole.
  - With 25 skips, 20 are listed and `skippedNotListed` is 5.
  - The spawned environment holds `COLUMNS=<EDA_PYTEST_COLUMNS>`.
  - The client source imports no XML parser (`test_a_client_parses_no_report.py` passes for eda).
- [ ] **AC7 — the SKIP verdict.**
  - `e2e --agent <id>` exits 0, with `verdict: skip` and a `tier-skipped` warning naming `e2e`.
  - The board's run has pending equal to its total.
- [ ] **AC8 — every pytest exit path.** On the fixture, each of these gives the shared outcome named in
  §S4:
  - a collection error (exit 2);
  - an empty entry (exit 5);
  - a missing node id and a broken `conftest.py` (exit 4);
  - a SIGTERM.
- [ ] **AC9 — `regression`.** One run under `regression` holds every test of the three entries once, and
  its start total is their count.
- [ ] **AC10 — the gate.** `pre-merge-gate` on the fixture plus `integration/sim`:
  - gives `suites[]` rows `unit`, `integration/net` and `integration/sim`, each with
    `client: eda-crucible.py` and its own run, counts (`pending` included) and outcome;
  - lists `e2e` as excluded;
  - has a `whole-suite skipped` statement, and no whole-suite run.

  A failing `integration/net` fails only its row. A row whose tests are all skipped puts its
  `tier-skipped` warning in the gate's `warnings`. `--suites unit` is scoped, and `--suites nosuch` is
  refused before any run.
- [ ] **AC11 — every call site (fleet rule).**
  - The parser offers `unit`, `module`, `integration`, `e2e`, `bdd` and `regression` through
    `add_tier_verbs`.
  - Each one, and `test` and `pre-merge-gate`, is refused while a cycle is active elsewhere, before an
    interpreter is spawned.
  - `test`, the five tier verbs, `regression` and `pre-merge-gate` each call the one interpreter
    resolver, and each calls the shared `pytest_command`. An AST caller count asserts both.
- [ ] **AC12 — the [glob] census and the invariants.**
  - Every list in §S7 includes eda, and its count pin moves by one.
  - `_crucible_axi.py` and `_crucible_run.py` keep the sizes pinned by `SHARED_MODULE_LINE_BUDGETS`.
  - `eda-crucible.py` holds no string-keyed tier literal.
  - The code and tests this CR adds carry no CR id literal.
- [ ] **AC13 — headless children.** A fixture test that writes its own `QT_QPA_PLATFORM`, `DISPLAY` and
  `WAYLAND_DISPLAY` into a file is run by `unit` with `DISPLAY` and `WAYLAND_DISPLAY` set in the client's
  own environment. The file reads `offscreen`, unset and unset. The same holds for `regression` and the
  gate's suites.

## Estimated size

8 points. The fleet surface comes through the shared modules, and the pytest path comes from CR-CRU-241. The
new parts are:

- the interpreter and key resolution;
- the declaration reader;
- runs per entry;
- the verdict and the skip list;
- the gate's suites.

## Risk

- **A wider `COLUMNS` lengthens every `-v` line.** Only the console log is affected; the board's record is
  the JUnit.
- **`-v` wording may change.** A pytest release that stops printing `SKIPPED (<reason>)` gives
  `reason: null`, and the verdict is unaffected.
- **The interim on develop.** Between this CR's merge and CR-CRU-243's, the schema does not name eda. Until
  CR-CRU-243 adds `eda-pytest` to their skip sets, a project mixing rust, arduino or maven `[targets]` with eda
  entries would see those clients refuse the eda entries. The wave releases only after CR-CRU-243.

## Non-goals

- Installing the client, the schema entry, the skip sets of the other clients, the [6] census and the docs
  (CR-CRU-243).
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
