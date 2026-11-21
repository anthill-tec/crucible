# CR-CRU-244 — an EDA gate script reports each check through the crucible-gate package

**Status:** PENDING · Pre-review: due — 13 points, user rulings, another project's surface
**Type:** feature
**Priority:** high. It is the path that P1's CR-PFC-010 gates use as written.
**Depends on:** CR-CRU-243
**Labels:** clients, eda, installer, packaging
**Phase:** design
**Design reference:** `docs/research/DN-crucible-live-test-progress.md` (the `crucible-events` shape); CR-CRU-200 §S1; CR-CRU-238 (the declaration and the writer rule)

## Context

An electronics project's gates are often standalone scripts rather than pytest. P1's CR-PFC-010 has two:

- `net_check.py` prints one PASS/FAIL line per row;
- `board_check.py` prints seven checks.

Each exits non-zero when a check fails, and each mutation test must "exit non-zero and name the
offender". Such a script has no way to report its checks to the board.

The board already decodes the `crucible-events` stream, and the shared relay already carries a stream to
an open run.

## Scope

- **The plug-in format is the existing `crucible-events` NDJSON:**
  - a `run-start`;
  - one `test-end` per check (`pass`, `fail` or `pending`, with a failure naming the offender and optional
    `steps`);
  - a `run-end`.

  There is no new codec or event kind.
- **The helper is a pip-installable package, `crucible-gate`,** installed into the project's own venv
  (import name `crucible_gate`). A script author never writes JSON by hand.
- **Where it lives and how it is versioned:**
  - its source is `packages/crucible-gate/` in this repo, with a `pyproject.toml` and
    `src/crucible_gate/__init__.py`;
  - its version comes from the repo's tags through hatch-vcs, so it equals `crucible-axi`'s;
  - it is stdlib-only and declares `requires-python >= 3.12`.
- **How it reaches a project:**
  - the `crucible-axi` wheel carries the package source as package data;
  - `crucible-axi install` builds the pure-Python wheel with the standard library's `zipfile`, stamped
    with the install's own version, into `<target-dir>/clients/wheels/`;
  - the install lists the wheel in `crucible-clients.json` as `gate_helper: {path, version}`;
  - a project installs it with `<venv python> -m pip install <that wheel>`.
- **Drift is refused on an integer.**
  - The package and the eda client each define `API_VERSION`, a positive integer that a repo test pins
    equal.
  - Before running a script, the client imports the package in the project's interpreter. It refuses when
    the package is missing or its `API_VERSION` differs, naming the install command.
  - A different release version is only stated in the envelope.
- **One script per entry, one run per entry.**
- **The skip reason rides the event.** A skip's reason travels in its `test-end`'s `failure.message`.
  The board drops it, as it drops every pending reason. The client reads it from the run's own stream file
  into the envelope's `skipped[]`.

### §S1 — the package API

`crucible_gate` exports:

- `API_VERSION = 1`;
- `__version__`, read from the installed distribution's metadata;
- `check(name, ok, detail=None, *, suite=None, steps=None)`, which writes one `test-end`:
  - `ok` → `pass`; otherwise `fail`, with `failure.message = detail or name`;
  - `suite` defaults to the script's file name;
  - each item of `steps` is `(name, ok[, detail])`, written as the event's `steps`;
- `skip(name, reason)`, which writes one `test-end` with `status: pending` and
  `failure: {message: reason}`.

**Lifecycle.**

- The first call writes `run-start`, with no total.
- An `atexit` hook writes `run-end`, with the counts the module kept. It runs on a normal exit and when
  an exception escapes.
- When any check failed, or an exception escaped, the hook ensures a non-zero exit status: a script that
  would exit 0 exits 1.

**Output.**

- Every line is written and flushed as it happens, to the file `CRUCIBLE_STREAM` names.
- Every call also prints `PASS <name>`, `FAIL <name>: <detail>` or `SKIP <name>: <reason>` on stdout.
- With `CRUCIBLE_STREAM` unset, it prints only. That is the by-hand mode.

### §S2 — the package's source, build and install

- **The source:** `packages/crucible-gate/pyproject.toml` (name `crucible-gate`, hatchling with hatch-vcs
  rooted at the repo, no dependencies) and `packages/crucible-gate/src/crucible_gate/__init__.py`.
- **The crucible-axi wheel** force-includes the package source.
- **`crucible-axi install`'s fleet stage** builds `crucible_gate-<version>-py3-none-any.whl`:
  - it holds `crucible_gate/__init__.py` and a `dist-info` with `METADATA`, `WHEEL` and `RECORD` (sha256
    and size per file);
  - it is written into `<target-dir>/clients/wheels/`, and an upgrade replaces it;
  - `build_manifest` lists it as `gate_helper: {path, version}`;
  - a packaged source that is missing fails the stage, naming the path.

### §S3 — the declaration

- **An entry** `[targets."<tier>"]` or `[targets."<tier>/<label>"]` with `framework = "eda-gate"` holds:
  - `script`: a path to a `.py` file, relative to the project dir. It is required and must exist.
  - `stream = { codec = "crucible-events", path = "env:CRUCIBLE_STREAM" }`, which is required, as in
    arduino's declared stream.
- **Refused fields:** `junit`, `console` and `coverage`.
- **The schema** gains `eda-gate` under `stacks.eda` (the framework values and these fields) and
  `reserved_frameworks.eda`. Its `version` goes up by one.
- **`eda-gate` joins the other-stack skip sets** of rust, arduino and maven.

### §S4 — running a script

For each `eda-gate` entry, the run proceeds in this order:

1. The client resolves the interpreter as CR-CRU-242 does.
2. It probes `import crucible_gate; print(crucible_gate.API_VERSION, crucible_gate.__version__)` in that
   interpreter. Absent, or another `API_VERSION`, is refused before any POST, with `ok: false`. The help
   names `<interpreter> -m pip install --upgrade <wheel>`, where `<wheel>` is the newest file in
   `<client dir>/wheels/`, or, when there is none, `crucible-axi install` first.
3. It refuses a board whose health lists no `crucible-events` under `codecs.stream`, before the run opens.
4. It opens the run under the entry's tier with framework `eda-gate`.
5. It runs `<interpreter> <script>` with the script's directory as the working directory and
   `CRUCIBLE_STREAM` set to a fresh stream file in the run's reports dir.
6. It relays the stream through the shared `StreamRelay`, and closes it through the shared
   `close_streamed_run`.

The envelope carries:

- `gateHelper: {apiVersion, version}`;
- `verdict`, `skipped[]` and the `tier-skipped` warning, as CR-CRU-242 §S5 defines them, with `skipped[]` read
  from the stream file's `pending` events.

### §S5 — tiers, `regression` and the gate

- **The tier verbs, `--entry` and the gate's per-entry suites** take `eda-gate` entries as they take
  `eda-pytest` ones. Each entry is one run.
- **`regression`** files the pytest union run plus one run per `eda-gate` entry, all under `regression`.
  The envelope sums their counts and lists them in `runs[]`.

## Acceptance criteria

- [ ] **AC1 — a script run reaches the board.**
  - **Setup:** a script calls `check("rowA", True)`, `check("rowB", False, "U4 B3 unconnected")` and
    `skip("bench", "not populated")`, and is declared as `integration/net`.
  - `integration --agent <id>` opens one streamed run (`codec: crucible-events`, tier `integration`,
    stack `eda`, framework `eda-gate`).
  - It is filed with passed 1, failed 1 and pending 1, and is not flagged incomplete.
  - The failing leaf's message is `U4 B3 unconnected`.
  - The envelope's `skipped` is `[{test: "bench", reason: "not populated"}]`.
- [ ] **AC2 — by hand.**
  - The same script with `CRUCIBLE_STREAM` unset prints `PASS rowA`, `FAIL rowB: U4 B3 unconnected` and
    `SKIP bench: not populated`, and exits 1.
  - A script whose checks all pass exits 0.
  - No file is written.
- [ ] **AC3 — every exit path.**
  - A script that raises after two checks leaves a stream with two `test-end` events and one `run-end`.
    It exits non-zero, and its run fails.
  - A script that writes no event and exits non-zero is filed through the compile ingest (`python`
    format).
  - A SIGTERM leaves the run aborted, keeping the tests it streamed.
  - A declared `script` that does not exist is refused before any run opens.
- [ ] **AC4 — the version check.** Against a scratch venv:
  - with no `crucible-gate` installed, the run is refused before any POST, and the help names
    `-m pip install --upgrade` and the wheel's path;
  - with a stub `crucible_gate` whose `API_VERSION` is 2, it is refused the same way;
  - with the built wheel installed, it runs, and the envelope's `gateHelper.apiVersion` is 1.
  - A repo test pins the eda client's `API_VERSION` equal to the package's.
- [ ] **AC5 — the package is portable.**
  - `crucible_gate/__init__.py` imports only standard-library modules (an AST check).
  - It parses with `ast.parse(..., feature_version=(3, 12))`.
  - Installed from the built wheel into a Python 3.13 interpreter, it runs AC1's script.
- [ ] **AC6 — the install builds and lists the wheel.**
  - Build the crucible-axi wheel, install it into a scratch target, and inspect the result:
    - `clients/wheels/crucible_gate-<v>-py3-none-any.whl` exists;
    - its `RECORD` hashes match;
    - `pip install` of it succeeds in a scratch venv;
    - `crucible-clients.json` has `gate_helper: {path, version}` with `version` equal to the manifest's.
  - A missing packaged source fails the stage, naming the path.
- [ ] **AC7 — the declaration and its readers.**
  - The schema's `version` goes up by one, with `eda-gate` in `stacks.eda` and in
    `reserved_frameworks.eda`.
  - The agreement test drives eda's `eda-gate` check from the schema.
  - A complete valid `eda-gate` entry is skipped by each of rust, arduino and maven (three call sites).
- [ ] **AC8 — mixed tier, `regression` and the gate.**
  - **Setup:** add `integration/py`, an `eda-pytest` entry.
  - `integration` opens two runs.
  - `regression` files the pytest union run and the `integration/net` run, both under `regression`, and
    its envelope sums them.
  - `pre-merge-gate` has a row per entry.
- [ ] **AC9 — a board without the stream codec.** A declared script run against a health without
  `crucible-events` is refused before the run opens, naming the codec.
- [ ] **AC10 — docs and invariants.**
  - README, RUNBOOK and CHANGELOG name:
    - the package, its API and its by-hand mode;
    - the wheel's location, the install command and the `API_VERSION` refusal;
    - the `eda-gate` declaration.
  - The shared modules keep their pinned sizes.
  - `FLEET_FILES` and its census pins are unchanged, because the wheel is built, not a fleet file.
    `EXPECTED_MANIFEST_KEYS` gains `gate_helper`.
  - The code and tests this CR adds carry no CR id literal.

## Estimated size

13 points: the package and its lifecycle (3), the wheel build, the manifest key and the install (4), and
the client's script runs, the version check, the declaration with its readers, and mixed tiers (6). If
the re-score exceeds 13, it splits at that seam:

- "the crucible-gate package ships with the fleet" (5);
- "the eda client runs declared gate scripts" (8).

## Risk

- **A hand-built wheel** must satisfy pip's checks of `RECORD` and `WHEEL`. AC6 installs it, to prove
  that.
- **A project pinning the wheel by path** in `requirements.txt` ties itself to one machine's install.
  RUNBOOK recommends running the install command.

## Non-goals

- Publishing to PyPI.
- A new codec or event kind.
- Storing a skip reason on the board.
- A pytest-to-stream reporter.
- Converting P1's scripts.
- Measured values as fields.
