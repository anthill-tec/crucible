# CR-CRU-063 — CI runs the gates but provisions no toolchain: 102 bun + 9 python failures on a real runner

**Status:** PENDING
**Type:** patch (CI verification)
**Priority:** P0 — release blocker. `publish-pypi` and `publish-npm` both `needs:` the three suites, so while they are red **nothing publishes**, tokens and trusted publishers notwithstanding.
**Depends on:** CR-CRU-062 (the test jobs this CR repairs)
**Labels:** patch, ci, github-actions, gates, test-infrastructure
**Phase:** Wave 4
**Design reference:** `docs/research/DN-release-process.md` §3 Step 4

## Context

**Measured 2026-08-13, run 31677479804** — the first real execution of CR-CRU-062's jobs, on the
first push of `develop` (`815edc8..7435a17`). This is CR-CRU-062's carry-forward item 1 being
exercised, and it failed:

| Job | Result |
|---|---|
| `build` | ✓ 20s |
| `pack-server` | ✓ 7s — the declared `bin` entrypoint ships |
| `test-e2e` | ✓ 1m57s — CR-CRU-052's scratch-cwd + `CRUCIBLE_DB` isolation holds on a runner (carry-forward item 2, previously reasoned about only) |
| `test-bun` | ✗ 1215 pass / 1 skip / **102 fail** / 4 err of 1318 |
| `test-python` | ✗ 673 ran / **7 fail / 2 err** |

**One dominant cause, counted not guessed: `error: Executable not found in $PATH: "uv"` appears 98
times** — ~96% of the bun failures. `tests/clients-bun-crucible.test.ts:83` drives the client fleet
as `["uv", "run", SCRIPT_PATH, ...]` (PEP 723 inline metadata, CR-CRU-046), and `oven-sh/setup-bun`
provides bun, not uv.

The same gap is visible on the Python side, where two suites **raise a `RuntimeError` naming their
own remedy**:

- `tests/client/test_cr046_uv_env_gate.py:167` — *"`uv` is not on PATH; the §S3 environment gate
  cannot be verified without it… Remedy: install uv."*
- `tests/client/test_crucible_axi_wheel_packaging.py:121` — *"no interpreter on this machine can
  `import build`… Remedy: `python3 -m pip install --upgrade build` (the same package release.yml's
  `build` job installs)."*
- `tests/client/test_cr040_coverage_tooling.py:172` — the gate venv's python must be able to execute
  `-m coverage`; `coverage` is absent.

**The defect is in the job definitions, not the suites.** CR-CRU-062 was merged on local evidence
(union regression 2009 passing) and asserted its Python job was *server-free* — which it is. But
server-free is not **dependency-free**, and nothing measured that distinction until the workflow ran
on a machine that was not this one. The suites declare their environmental prerequisites honestly;
CI simply does not satisfy them.

**On the 683 → 673 count.** The 10 "missing" tests are not missing. They are the members of the two
classes whose `setUpClass` raised — an aborted class contributes one error, not its test count. This
is expected to resolve with §S1/§S2 and must be **re-measured**, not assumed.

## Scope

### §S1 — `uv` on both test jobs

Install `uv` in `test-bun` and `test-python` before their suites run. `uv` is a hard prerequisite of
the documented client invocation (`uv run <client>.py`, CR-CRU-046 §S3), so it is a prerequisite of
any job that exercises a client.

Prefer the maintained action (`astral-sh/setup-uv`) over a hand-rolled `curl | sh`: it is cached and
pins a version, and a release gate must not depend on an unpinned network script.

`test-e2e` does **not** need it — it passed, and it drives the UI, not the client fleet. Do not add
it there for symmetry; every added step is another thing that can fail on release day.

### §S2 — The Python job installs the toolchain the suites declare

`pyproject.toml:27` already declares the coverage path as an optional dependency group:

```toml
[project.optional-dependencies]
dev = ["coverage>=7"]
```

**Consume that group — do not restate its contents in YAML.** A hardcoded `pip install coverage` in
the workflow is a second declaration of the same fact, and the two will drift.

The job therefore installs the project with its `dev` extra, plus `build` (required by
`test_crucible_axi_wheel_packaging`, and already installed by the `build` job — the asymmetry is the
bug).

### §S3 — Re-measure, then classify what is left

After §S1–§S2, **re-run and re-measure**. The following are **unclassified**, and this CR does not
pretend to know their cause:

| Failure | File |
|---|---|
| `test_zero_discovery_emits_definitive_no_tests_discovered_error_and_skips_compile_ingest` | `test_cr039_regression_discovery.py:177` |
| `test_test_verb_runs_real_unittest_and_ingests_with_run_summary` (`stdout=''`, exit 1) | `test_python_crucible_axi.py:1085` |
| `test_test_verb_includes_captured_runner_output_as_raw_in_parsed_payload` (`stdout=''`, exit 1) | `test_python_crucible_axi.py:1129` |
| `test_pre_merge_gate_emits_envelope_in_python` | `test_toolchain_verb_envelopes.py:430` |
| `test_python_pre_merge_gate_help_differs_between_py_compile_failure_and_pass` | `test_toolchain_verb_envelopes.py:514` |
| `test_docker_e2e_gate_emits_envelope_with_run_block` | `test_toolchain_verb_envelopes.py:285` |
| 4 bun errors — `Unable to connect` / `socket connection was closed unexpectedly` | unlocated; no source-text match in `tests/` |

Each surviving failure gets a **named cause and a fix**, or an explicit recorded deferral with
evidence. A count that goes down is not a classification.

🚨 **The suites are the contract, not the target.** If a test asserts something true of a developer
machine but not of a runner, the job is what changes. A test may only be altered where the assertion
itself is provably wrong, and that must be argued in the Implementation Notes — never to make a
number go green.

### §S4 — A guard so the provisioning cannot silently regress

The repo already tests `release.yml` **as data** — `tests/cr009-release-bundle.test.ts` and the
CR-CRU-041/061 topology suites parse it with `Bun.YAML.parse` and assert on its job graph. Extend
that existing pattern (do not introduce a second CI-testing mechanism):

- `test-bun` and `test-python` each carry a `uv` provisioning step;
- `test-python` installs the `dev` extra from `pyproject.toml` rather than a literal package list;
- the assertion is on the **parsed job graph**, not a substring of the file.

## Acceptance criteria

1. `test-bun` provisions `uv` before `bun test`; the string `Executable not found in $PATH: "uv"`
   appears **zero** times in its log.
2. `test-python` provisions `uv` **and** installs the project's `dev` extra + `build` before the
   suite runs.
3. `test-bun` on a real runner: **0 failures, 0 errors**.
4. `test-python` on a real runner: **0 failures, 0 errors**, and the discovered-test count matches
   the local count (683 at time of writing) — proving the two aborted classes now run rather than
   being counted as two errors.
5. `test-e2e`, `build` and `pack-server` remain green and **unmodified** by this CR.
6. Every failure enumerated in §S3 is either fixed with a named cause or recorded as a deferral with
   evidence in the Implementation Notes. No silent disappearances.
7. `release.yml` is asserted as a parsed job graph per §S4, and the new assertions fail if either
   provisioning step is removed.
8. The `dev` extra is declared in exactly **one** place (`pyproject.toml`) — no package list
   duplicated into the workflow.
9. No `if:` condition is added to any test job (CR-CRU-062 §S0: an event-scoped test job does not
   exist in the release run, and a publish that `needs:` a skipped job publishes nothing).

## Risk

- **A green local run proves nothing here.** The subject of this CR is runner behaviour, so the only
  admissible evidence is a real push. Every cycle's claim must cite a run id.
- **Provisioning creep.** The temptation after each red run is to add another install step until the
  suite passes. Each addition must name the test that demands it; an unexplained install is an
  unexplained dependency.
- **§S3 is where this CR can quietly fail.** Nine unclassified failures is a small enough number to
  "fix" by weakening assertions. That would convert a real gate back into the decoration CR-CRU-062
  existed to remove.

## Implementation notes

### §S3 classification — C2, measured on run 31726344668 (5 remaining `test-python` failures)

**One named cause covers all five: the `test-python` job's interpreter has no `xmlrunner`.**
`unittest-xml-reporting` was declared NOWHERE — not in `pyproject.toml`, not in the clients' PEP 723
blocks (which must stay `dependencies = []`, `test_cr046_uv_env_gate.py:340`), not in the workflow —
yet `python-crucible.py:442` builds every `test` / `regression` / `pre-merge-gate` run as
`<python> -m xmlrunner …`. On a dev box the module is present (here: user site-packages, 4.0.0); on
a runner `pip install '.[dev]' build` yields `build`, `coverage`, `crucible-axi`, `packaging`,
`pip`, `pyproject_hooks` — and no `xmlrunner`. Every one of the five tests drives that real
xmlrunner path with `--python <this interpreter>`, so the child dies with
`No module named 'xmlrunner'`, no `TEST-*.xml` is produced, and the client takes a no-XML fallback
that writes to stderr only — hence the shared signature **exit 1 with completely empty stdout**.

| # | Failure | Named cause | Fix |
|---|---|---|---|
| 1 | `test_cr039_regression_discovery.py:177` | `python -m xmlrunner discover` dies before running, so the capture carries no `Ran 0 tests`; `_is_zero_discovery` (correctly) refuses to call a silent crash a benign zero-discovery and routes to the compile fallback — which emits no envelope, so `_decode_axi` sees `{}` | provisioning |
| 2 | `test_python_crucible_axi.py:1085` | same missing module ⇒ no XML ⇒ `cmd_test`'s compile fallback ⇒ exit 1, no `run` block | provisioning |
| 3 | `test_python_crucible_axi.py:1129` | as #2; `raw` never reaches `/api/v2/runs/parsed` because the parsed ingest never happens | provisioning |
| 4 | `test_toolchain_verb_envelopes.py:430` | `pre-merge-gate` python: py_compile passes (`exit=0` in the captured stderr), then its regression step runs `coverage run … -m xmlrunner` → `No module named 'xmlrunner'` → no gate envelope | provisioning |
| 5 | `test_toolchain_verb_envelopes.py:514` | as #4, on the *passing* leg of the help-differs pair | provisioning |

**Fix (one line, one place):** `pyproject.toml`'s `dev` extra now declares
`unittest-xml-reporting>=4` alongside `coverage>=7`. **`release.yml` is not touched** — the
`pip install '.[dev]'` step §S2 already added consumes the group, so AC8 (exactly one declaration)
and the §S4 guard both hold unchanged (`tests/ci-toolchain-provisioning.test.ts`: 7 pass). `>=4`,
not `>=3`: 4.x stamps `file=` on each `<testcase>`, which is what keeps `_parse_junit_dir`'s `files`
count per-FILE instead of degrading to per-CLASS (`python-crucible.py:456`).

**Local reproduction** (required before touching production code) — an exact mirror of the job's
provisioning, not an approximation:

```bash
python3 -m venv /tmp/civenv-cr063
/tmp/civenv-cr063/bin/python -m pip install --upgrade '.[dev]' build   # the job's two install steps
/tmp/civenv-cr063/bin/python -m unittest \
  tests.client.test_cr039_regression_discovery \
  tests.client.test_python_crucible_axi \
  tests.client.test_toolchain_verb_envelopes
```

`Ran 64 tests … FAILED (failures=5)` — the same five, by name, as run 31726344668. After the
pyproject change and a re-`pip install '.[dev]'` in that same venv: `Ran 64 tests … OK`.

**The sanitised-PATH hypothesis is refuted, with evidence.** `drive_verb`
(`test_client_fleet_envelope_census.py:455`) *prepends* the fake bin dir —
`env["PATH"] = fake_bin_dir + os.pathsep + env["PATH"]` — it never strips PATH, and the client
resolves its interpreter by absolute path (`_resolve_python`), so PATH cannot starve it. Measured:
the three modules are `OK` (64/64) under `env -i PATH=/usr/bin:/bin`, and a probe with a genuinely
EMPTY PATH fails a *different* set of ten (rust/mvn/bun/arduino verbs needing real `git`/`sh`) while
all five python failures stay green — the opposite of CI's fingerprint.

### Deferred, with evidence: the no-XML fallback emits no envelope (a real AXI violation)

Exit-1-with-empty-stdout is itself a CR-CRU-030 §S1 breach: `cmd_test`'s no-XML branch
(`python-crucible.py:682-685`) and `_regression_run`'s non-zero-discovery branch (`:761-765`) both
`_ingest_compile(...)` and return, printing to **stderr only**. An agent whose toolchain is missing
therefore gets an exit code and nothing machine-readable. **Not fixed here, deliberately:**

1. It is **fleet-wide, not python-local** — `bun-crucible.py:796-802` has the byte-equivalent
   envelope-less fallback. Fixing one client would break the "modelled exactly on
   bun-crucible.py" symmetry the fleet's design rests on; it needs a RED-first CR across all five
   clients (CR-CRU-030/058 territory), not a patch smuggled into a CI-provisioning CR.
2. It **fixes none of the five**: each asserts a *successful* xmlrunner run (exit 0 + a real `run`
   block, or the `no-tests-discovered` warning that only a real `Ran 0 tests` capture produces).
   Emitting `ok:false` on the crash path leaves all five red. Proven by the reproduction above.

No test file was altered by C2 — §S3's "the suites are the contract" needed no exemption, because
every one of the five assertions was true and the environment was wrong.
