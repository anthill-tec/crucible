# CR-CRU-276 — the eda client runs declared gate scripts

**Status:** PENDING · split from CR-CRU-244 at its gap analysis (2026-11-28)
**Type:** feature
**Priority:** high. It is the path that P1's CR-PFC-010 gates use as written.
**Depends on:** CR-CRU-244
**Labels:** clients, eda, schema
**Phase:** design
**Design reference:** CR-CRU-244 (the `crucible-gate` package); CR-CRU-242 (the eda client, its verdicts and skips); CR-CRU-243 (schema v4 and its vocabulary); CR-CRU-238 (the declaration and the writer rule); python's `_streamed_run` (the streamed run with a compile fallback)

## Context

CR-CRU-244 ships `crucible-gate`, the helper a gate script calls to write a `crucible-events` stream. This CR lets a
project declare such a script as an eda entry and has the eda client run it, relay its stream to an open run, and file
it with the same verdicts, skips, tiers and gate as an `eda-pytest` entry.

## Scope

- **A second eda framework, `eda-gate`:** one script per entry, one run per entry.
- **The skip reason rides the event.** A skip's reason travels in its `test-end`'s `failure.message`; the board drops it,
  as it drops every pending reason, and the client reads it from the run's own stream file into `skipped[]`.
- **A project with only `eda-gate` entries needs no pytest.** The pytest probe runs only when an `eda-pytest` entry runs.
- **The working directory is the script's own directory** (user ruling, 2026-11-28; P1's CR-PFC-010 runs its board
  tools from `hardware/controller-board/`). The RUNBOOK advises resolving paths from `__file__`.

### §S1 — the declaration

- **An entry** `[targets."<tier>"]` or `[targets."<tier>/<label>"]` with `framework = "eda-gate"` holds:
  - `script`: a path to an existing `.py` file, relative to the project dir or absolute. Required.
  - `stream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }`, required, as in arduino's declared stream.
- **Per framework:** an `eda-gate` entry refuses `paths`, `junit`, `console` and `coverage`; an `eda-pytest` entry
  refuses `script` and `stream`, and keeps today's handling of every other field.
- **The schema goes to version 5,** with new vocabulary (user ruling): `when` may carry `excludes` and `refused` (rules
  for one framework value), and a path form `{"path": {"is": "file", "suffix": ".py"}}`. `stacks.eda` gains
  `eda-gate`'s fields and rules, and `reserved_frameworks.eda` gains `eda-gate`.
- **`eda-gate` joins the other-stack skip sets** of rust, arduino and maven, and the agreement test drives it from the
  schema; the two agreement tests that pin `["eda-pytest"]` move with it.

### §S2 — running a script

For each `eda-gate` entry, in this order:

1. The client resolves the interpreter as CR-CRU-242 does, without the pytest probe.
2. It probes `import crucible_gate; print(crucible_gate.API_VERSION, crucible_gate.__version__)` in that interpreter,
   headless and with a timeout. Absent, or another `API_VERSION` than the client's own `GATE_API_VERSION`, is refused
   before any POST, with `ok: false`. The help names `<interpreter> -m pip install --upgrade <wheel>` and
   `uv pip install --python <interpreter> <wheel>`, where `<wheel>` is the manifest's `gate_helper.path` (or, with no
   manifest, the one wheel in `<client dir>/../wheels/`); with neither, it names `crucible-axi install` first.
3. It refuses a board whose health lists no `crucible-events` under `codecs.stream`, before the run opens.
4. It opens the run under the entry's tier with framework `eda-gate`.
5. It runs `<interpreter> <script>` in the script's directory, headless, with `CRUCIBLE_STREAM` set to a fresh stream
   file in the run's reports dir, through `--hermetic` when asked.
6. It relays the stream through the shared `StreamRelay` and closes it through the shared `close_streamed_run`, with a
   signal held across the close as across an ingest (CR-CRU-243).

**Outcomes:** a script that streamed its checks is filed from the stream; a script that wrote no event and exited
non-zero is filed through the compile ingest (`python` format) carrying its output; a script that wrote no event and
exited 0 aborts the run as ran-nothing; a SIGTERM to the client while the script runs aborts the run, keeping the tests
it streamed.

**The envelope carries:** `gateHelper: {apiVersion, version}`; `verdict`, `skipped[]` (from the stream file's `pending`
events) and the `tier-skipped` warning as CR-CRU-242 §S5 defines them; the wall-vs-CPU warning on `unit`.

### §S3 — tiers, `regression` and the gate

- **The tier verbs, `--entry` and the gate's per-entry suites** take `eda-gate` entries as they take `eda-pytest` ones.
- **`regression`** files the pytest union run (only when an `eda-pytest` entry exists) plus one run per `eda-gate` entry,
  all under `regression`. Its envelope reuses `entries[]`, keyed like the tier verbs (the union run keyed `regression`),
  and sums their counts.

## Acceptance criteria

- [ ] **AC1 — a script run reaches the board.** A script calling `check("rowA", True)`,
  `check("rowB", False, "U4 B3 unconnected")` and `skip("bench", "not populated")`, declared as `integration/net`:
  `integration --agent <id>` opens one streamed run (`codec: crucible-events`, tier `integration`, stack `eda`,
  framework `eda-gate`), filed with passed 1, failed 1, pending 1, not incomplete; the failing leaf's message is
  `U4 B3 unconnected`; `skipped` is `[{test: "bench", reason: "not populated"}]`; `verdict` is `fail`.
- [ ] **AC2 — every exit path.** A script that raises after two checks is filed from its stream and fails; one that
  writes no event and exits non-zero is filed through the compile ingest; one that writes no event and exits 0 is
  aborted as ran-nothing; a SIGTERM to the client aborts the run keeping its streamed tests, with one envelope and exit
  143; a declared `script` that does not exist is refused before any run opens.
- [ ] **AC3 — the version check.** Against a scratch venv: no `crucible-gate` → refused before any POST, the help naming
  both install commands and the wheel's path; a stub `crucible_gate` with `API_VERSION` 2 → refused the same way; the
  built wheel installed → it runs, and `gateHelper.apiVersion` is 1. A test pins the client's `GATE_API_VERSION` equal
  to the package's `API_VERSION`.
- [ ] **AC4 — no pytest needed.** A project with only `eda-gate` entries and an interpreter without pytest runs its tier
  verbs, `regression` and the gate; `regression` opens no pytest run.
- [ ] **AC5 — the declaration and its readers.** Schema `version` 5; `reserved_frameworks.eda` holds both frameworks;
  the agreement test, through the new vocabulary, drives eda's `eda-gate` check (a valid entry accepted; a missing or
  non-`.py` `script`, a missing `stream`, and `paths` on `eda-gate` refused; `script` on `eda-pytest` refused); a
  complete valid `eda-gate` entry is skipped by rust, arduino and maven.
- [ ] **AC6 — mixed tier, `regression` and the gate.** With `integration/py` (`eda-pytest`) beside `integration/net`:
  `integration` opens two runs; `regression` files the union run and the `integration/net` run under `regression`,
  `entries[]` lists both and the envelope sums them; `pre-merge-gate` has a row per entry.
- [ ] **AC7 — a board without the stream codec.** A declared script run against a health without `crucible-events` is
  refused before the run opens, naming the codec.
- [ ] **AC8 — headless and in its own directory.** A script recording its working directory and `QT_QPA_PLATFORM`,
  `DISPLAY` and `WAYLAND_DISPLAY` reads its own directory, `offscreen`, unset, unset — on a tier verb, `regression` and
  a gate suite.
- [ ] **AC9 — docs** (reviewed): README, RUNBOOK and CHANGELOG ("Stack declaration changes": v5, its vocabulary,
  `eda-gate`, the skip sets) name the `eda-gate` declaration, the working directory, the `API_VERSION` refusal and the
  install commands.

### Reviewed, not tested

- No CR id or AC label in any added line under `clients/` or `tests/`.

## Estimated size

10 points: the schema v5 vocabulary with the agreement harness and the skip sets (3), the script run, the version
check and the outcomes (4), tiers, `regression` and the gate (2), docs (1).

## Risk

- **A vocabulary change reaches Model B's writer** again (v4 → v5); under CR-CRU-238's newer-version rule it warns and
  writes only what it knows until it learns the new forms.
- **A script that relies on the project dir** as its working directory finds its files only through `__file__`; the
  RUNBOOK says so.

## Non-goals

- The package itself (CR-CRU-244).
- A new codec or event kind.
- Converting P1's scripts.
- Measured values as fields.
