# CR-CRU-244 — the crucible-gate package ships with the fleet

**Status:** PENDING · revised after gap analysis and user rulings (2026-11-28); split, with CR-CRU-276
**Type:** feature
**Priority:** high. It is the helper that P1's CR-PFC-010 gate scripts use, and CR-CRU-276 runs them.
**Depends on:** CR-CRU-243
**Labels:** installer, packaging, eda
**Phase:** design
**Design reference:** `docs/research/DN-crucible-live-test-progress.md` (the `crucible-events` shape); CR-CRU-200 §S1; `clients/subtest_runner.py` (a stdlib-only `crucible-events` writer)

## Context

An electronics project's gates are often standalone scripts rather than pytest. P1's CR-PFC-010 specifies two,
`net_check.py` and `board_check.py`, each printing one PASS/FAIL line per check and exiting non-zero when one fails.
Such a script has no way to report its checks to the board.

The board already decodes the `crucible-events` stream, and the shared relay already carries a stream to an open run.
This CR ships the helper a script calls to write that stream: the `crucible-gate` package, built by the install into a
wheel a project installs into its own venv. CR-CRU-276 then lets the eda client run a declared script and file it.

The gap analysis re-scored the original CR at 16–17 points, so it was split at the seam the spec named (user ruling,
2026-11-28): this CR is the package; CR-CRU-276 is the client.

## Scope

- **The plug-in format is the existing `crucible-events` NDJSON:** a `run-start`, one `test-end` per check (`pass`,
  `fail` or `pending`, with a failure naming the offender and optional `steps`), and a `run-end`. There is no new codec
  or event kind.
- **The helper is a pip-installable package, `crucible-gate`** (import name `crucible_gate`), stdlib-only, declaring
  `requires-python >= 3.12`. A script author never writes JSON by hand.
- **Drift is refused on an integer.** The package defines `API_VERSION`, a positive integer; CR-CRU-276's client checks
  it. A different release version is only stated, never refused.

### §S1 — the package API

`crucible_gate` exports:

- `API_VERSION = 1`;
- `__version__`, read from the installed distribution's metadata, or `"0+unknown"` when the module runs uninstalled;
- `check(name, ok, detail=None, *, suite=None, steps=None)`, which writes one `test-end`:
  - `ok` → `pass`; otherwise `fail`, with `failure.message = detail or name`;
  - `suite` defaults to the script's file name;
  - each item of `steps` is `(name, ok[, detail])`, written as a step `{name, status: pass|fail, failure: {message}}`
    (the message only on a failing step, `detail or name`); a failing step does not by itself fail the check — `ok`
    decides it;
- `skip(name, reason)`, which writes one `test-end` with `status: pending` and `failure: {message: reason}`.

**Lifecycle.**

- The first `check` or `skip` writes `run-start`, with no total.
- At exit, when at least one check or skip was written, `run-end` is written with the counts the module kept. When
  none was written, nothing is written at all (no `run-start`, no `run-end`).
- The exit hook chains `sys.excepthook` to note an escaped exception. When any check failed, or an exception escaped,
  it flushes stdout, stderr and the stream and ends the process with `os._exit(1)`: the script exits 1, whatever exit
  status it would otherwise have had. When every check passed and no exception escaped, the script's own exit status
  stands.
- The module removes `CRUCIBLE_STREAM` from `os.environ` once it has opened the stream, so a child process the script
  starts never writes into it.
- A write to the stream that fails (the file cannot be opened or written) is reported once on stderr, and the module
  goes on printing; the script's checks still decide its exit.

**Output.**

- Every line is written and flushed as it happens, to the file `CRUCIBLE_STREAM` names.
- Every call also prints `PASS <name>`, `FAIL <name>: <detail>` or `SKIP <name>: <reason>` on stdout.
- With `CRUCIBLE_STREAM` unset, it prints only. That is the by-hand mode.

### §S2 — the package's source, build and install

- **The source:** `packages/crucible-gate/pyproject.toml` — minimal and static: name `crucible-gate`,
  `requires-python = ">=3.12"`, no dependencies, no build backend run by this repo; the install's wheel builder reads
  its name and `requires-python` — and `packages/crucible-gate/src/crucible_gate/__init__.py`.
- **The crucible-axi wheel and sdist** carry the package source as package data at a named path inside `crucible_axi`;
  the sdist's include rules and the CR-CRU-266 content pins gain it.
- **`crucible-axi install`'s fleet stage** builds `crucible_gate-<version>-py3-none-any.whl` with the standard
  library's `zipfile`:
  - `<version>` is the install's own version, from the same source the manifest's `version` uses;
  - it holds `crucible_gate/__init__.py` and a `dist-info` with `METADATA`, `WHEEL` and `RECORD` (sha256 and size per
    file), and is byte-reproducible: the same source and version give the same bytes (fixed timestamps and order);
  - it is written into `<target-dir>/wheels/` (beside `clients/`, so the client fleet is unchanged), and that
    directory keeps exactly one `crucible_gate-*.whl`: an upgrade removes any other;
  - a second install with nothing changed converges;
  - a packaged source that is missing fails the stage, naming the path.
- **The manifest** lists it as `gate_helper: {path, version}`; `EXPECTED_MANIFEST_KEYS` gains `gate_helper`.

## Acceptance criteria

- [ ] **AC1 — by hand.** A script calling `check("rowA", True)`, `check("rowB", False, "U4 B3 unconnected")` and
  `skip("bench", "not populated")`, with `CRUCIBLE_STREAM` unset, prints `PASS rowA`, `FAIL rowB: U4 B3 unconnected`
  and `SKIP bench: not populated`, exits 1, and writes no file. A script whose checks all pass exits 0.
- [ ] **AC2 — the stream.** The same script with `CRUCIBLE_STREAM` set writes `run-start`, three `test-end` events
  (`pass`, `fail` with message `U4 B3 unconnected`, `pending` with message `not populated`) and a `run-end` with
  counts 1/1/1; `steps` are written as §S1 states; `CRUCIBLE_STREAM` is gone from a child process's environment.
- [ ] **AC3 — every exit path.**
  - A script that raises after two checks leaves two `test-end` events and one `run-end`, and exits 1.
  - A script that calls `sys.exit(2)` after a failed check exits 1; one that calls `sys.exit(3)` with every check
    passing exits 3.
  - A script that checks nothing writes no file and keeps its own exit status.
  - An unwritable stream path is reported once on stderr; the checks still print and decide the exit.
- [ ] **AC4 — portable.** The wheel the install builds, installed into a bare Python 3.12 venv, imports and runs AC2's
  script.
- [ ] **AC5 — the install builds and lists the wheel.** Through the existing install tests (wheel → scratch venv, and
  `crucible-axi install --target-dir`):
  - `<target>/wheels/crucible_gate-<v>-py3-none-any.whl` exists, its `RECORD` hashes match, and `pip install` of it
    succeeds in a scratch venv;
  - `crucible-clients.json` has `gate_helper: {path, version}`, with `version` equal to the manifest's;
  - a second install converges; an install over a different-version wheel leaves exactly one wheel;
  - a missing packaged source fails the stage, naming the path.
- [ ] **AC6 — docs** (reviewed): README, RUNBOOK and CHANGELOG name the package, its API and by-hand mode, the wheel's
  location, and the install commands (`<interpreter> -m pip install --upgrade <wheel>`, and for a uv venv,
  `uv pip install --python <interpreter> <wheel>`).

### Reviewed, not tested

- `crucible_gate/__init__.py` imports only standard-library modules and parses under Python 3.12.
- `FLEET_FILES` is unchanged.
- No CR id or AC label in any added line under `clients/`, `crucible_axi/`, `packages/` or `tests/`.

## Estimated size

6 points: the package and its lifecycle (3), the wheel build, the manifest key, the sdist/wheel content and the
install (3).

## Risk

- **A hand-built wheel** must satisfy pip's checks of `RECORD` and `WHEEL`. AC4 and AC5 install it, to prove that.
- **`os._exit` skips other exit handlers** the script registered after importing `crucible_gate`. The RUNBOOK states
  it; a failed gate is the case where that matters least.
- **A project pinning the wheel by path** in `requirements.txt` ties itself to one machine's install. RUNBOOK
  recommends running the install command.

## Non-goals

- The eda client running a script, the `eda-gate` declaration and the schema (CR-CRU-276).
- Publishing to PyPI.
- A new codec or event kind.
- Storing a skip reason on the board.
- A pytest-to-stream reporter.
- Converting P1's scripts.
- Measured values as fields.
