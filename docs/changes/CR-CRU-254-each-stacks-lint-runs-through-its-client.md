# CR-CRU-254 — each stack's lint runs through its client, and the gate runs it after check

**Status:** PENDING · filed 2026-11-13 (user ruling: CR-CRU-199 split in three for ease of execution; this is
the client side of the lint design Model B asked for, Sandesh #1486 → #1488) · gap analysis:
`test-reports/work/cr199-gap-analysis.md`; design D1, D2, D5–D7 approved by the user 2026-11-13; Crucible's own
gate declares ruff (user ruling 2026-11-13) · Pre-review: ran 2026-11-13 (it changes every client, the gate's
machine contract Model B reads, and the shipped fleet); CHANGES, 14 findings folded
**Type:** feature
**Points:** 13 (8 at filing; the pre-review's folds add the per-client stage orders, the rust contract mapping,
go's modules, the fleet lists and three censuses)
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-199 (merged: the board accepts the `lint` marker and decodes ruff and clippy); CR-CRU-253
(merged: the project's ruff rule set, and a tree clean on it)
**Labels:** clients, shared-module, gate, installer, docs
**Design reference:** CR-CRU-199 (the marker, the decoders, the view); CR-CRU-155 / the `[gate] skip`
declaration (a project table read project → install, first file wins, a malformed one refused); CR-CRU-221 (a
shared client module of its own, shipped with the fleet); CR-CRU-230 §S1 (every list that names the shared
modules); CR-CRU-056 (the gated-run pre-flight)

## Problem

- **Only rust lints.** Its `clippy` and `workspace-clippy` verbs run clippy, and its `pre-merge-gate` starts with a
  fail-fast workspace clippy step. No other client lints.
- **The gate is the wrong place for a linter command.** Model B wants a lint step in every project's gate. Without
  a client verb, its stack files would each name a linter command beside the client (#1486).
- **`check` must stay "does it compile".** Folding lint into `check` would blur the signal an agent reads as "does
  not compile". The user ruled this out (2026-10-19).

## Design (user rulings 2026-11-13; pre-review folds marked)

- **D1 — the declaration.** A project names its linter in a `[lint]` table of `crucible.toml`:

  ```toml
  [lint]
  command = ["ruff", "check", "--output-format", "concise", "."]
  format  = "ruff"
  ```

  - **Resolution:** the table is resolved as `[gate]` is: the project's own file first, then the install's. The
    first file that parses wins. So a project file without `[lint]` hides the install's, and a project with no
    file of its own inherits an install-wide `[lint]`, whatever its stack, replacing its stack's default (fold
    F14; the RUNBOOK warns of it).
  - **The fields:**
    - `command` is a non-empty list of non-empty strings.
    - `format` names the board's decoder (CR-CRU-199). It may be omitted; the client then posts none, and the
      board detects the format, falling back to raw.
    - `name` is optional, a non-empty string (fold F2).
  - **The marker** (fold F2). The `lint` value posted, and the envelope's `linter`, is:
    - `name` when it is declared;
    - otherwise `format` when it is declared;
    - otherwise the basename of the command's first word.

    So `["python", "-m", "ruff", …]` with `format = "ruff"` posts `lint: "ruff"`. The rust default posts
    `clippy` and the go default `go vet`.
  - **A malformed table is refused**, naming the file, before any linter starts.
  - **Defaults when nothing is declared:**
    - rust: `cargo clippy --workspace --all-targets --all-features -- -D warnings`, format `clippy`. This is today's
      gate step, run with the same environment (`CARGO_BUILD_JOBS`), so nothing changes for a rust project (fold
      F4).
    - go: `go vet ./...`, format `go vet`, run once in each module the go client already discovers (fold F5). The
      outputs are joined in module order into one post, and the exit is the first non-zero one, or 0.
    - python, bun, maven and arduino have no default.
  - **A declared `command` replaces the default** (D7: golangci-lint replaces `go vet`; it does not run beside it).
- **D2 — the verdict is the linter's.** `lint` fails when the linter exits non-zero, so the project's own linter
  configuration decides what blocks.
- **Nothing to lint.** With no declaration and no default, `lint` answers `ok: true` with `skipped: not-declared`.
- **D5 — rust keeps its verbs.**
  - `clippy` and `workspace-clippy` stay, unchanged in what they run.
  - Their filings carry the `lint` marker from now on (fold F12).
  - The rust gate's clippy step becomes its `lint` step (§S3).
- **D6 — maven and arduino** lint only what a project declares, such as `mvn checkstyle:check` or `clang-tidy …`.
- **The gate** runs `lint` fail-fast before the tests, in each client's own stage order (§S3, fold F3).
  - A failing lint stops the gate there.
  - A skipped lint lets the gate continue, with a `lint-not-declared` warning.
- **`check` never runs a linter.**

## Steps

### §S1 — one shared lint runner, and every list that names the shared modules

- **A new shared client module, `clients/_crucible_lint.py`,** holds everything common:
  - the `[lint]` resolution and its refusals;
  - the defaults' commands;
  - the marker rule;
  - running the command;
  - the post;
  - the envelope;
  - the help steps;
  - the gate stage, with its warning;
  - `_run_brief`'s lint wording (fold F11).
- **The shared core** (9117 lines) keeps its standing 80-line headroom under its 9200 guard, so it ends at or
  under 9120 (amended at RED 946: the headroom pin is CR-CRU-221's invariant). It gains only the loader's entry;
  the carried-warnings channel through which the gate's `lint-not-declared` reaches the gate's envelope (fold F11)
  lives in `_crucible_lint.py` or rides an existing core seam.
  `HELP_STEPS["check"]` becomes the lint step where a gate runs lint next.
- **Every list and fixture that names the shared modules gains `_crucible_lint.py`** (fold F9, the CR-CRU-230 §S1
  precedent):
  - `FLEET_FILES` (`crucible_axi/install.py`);
  - `EXPECTED_FLEET_FILES` (`test_cr090_fleet_stage`, `test_cr090_cli_install_integration`);
  - `EXPECTED_CLIENT_PAYLOAD` (`test_crucible_axi_wheel_packaging`);
  - the scratch-fleet copies:
    - `test_client_fleet_envelope_census`;
    - `test_a_clients_board_is_its_projects_configuration`;
    - `test_no_suite_resolves_the_checkout_configuration` (`_SCRATCH_FLEET`);
    - `test_client_limits_resolve_from_configuration`;
  - `SHARED_MODULE_NAMES` (`test_cr054_drift_guard`);
  - `SHARED_MODULES` (`test_a_runs_ingest_helpers_live_once_in_the_shared_module`,
    `clients-never-self-register-a-project.test.ts`);
  - `milestone-vocabulary-has-one-source.test.ts`;
  - the stdlib-only and ruff checks of `test_the_run_pipeline_lives_in_its_own_shared_module`;
  - `project-namespace-tripwire.test.ts`'s citation counts;
  - `SHARED_MODULE_LINE_BUDGETS` in its three copies;
  - the README's shared-module sentence.

  Each of these is an approved test or doc edit.

### §S2 — the `lint` verb in every client

`python-crucible.py`, `bun-crucible.py`, `rust-crucible.py`, `go-crucible.py`, `mvn-crucible.py` and
`arduino-crucible.py` each gain `lint [--agent ID] [--cycle N]`, built on §S1.

**Where it runs, and how the command is found** (fold F6):

- Every client runs the command in the project directory, except bun, which runs it in its package directory
  (`[bun] package_dir`), where `check` runs.
- A first word holding no `/` is looked up on PATH.
- A first word holding `/` is resolved against that run directory, as `.venv/bin/ruff` or
  `./node_modules/.bin/eslint` are.
- Either way, a command that is not found is refused, naming it, and nothing is posted.

**The output** (fold F7). stdout and stderr are captured as one ordered stream, in text mode, and posted whole.

**The post** carries:

- `format`, when it is known;
- `lint`, the marker;
- `runnerExit`, the linter's exit;
- the output;
- the `--cycle` context, through `cycle_context`.

A clean run is posted even when the linter printed nothing.

**Before the linter starts** (fold F8):

- `lint` makes the gated-run pre-flight (`preflight_cycle_warnings`), as `clippy` does.
- Without `--agent`, `lint` runs and posts nothing.

**The envelope** (fold F1) names:

- `linter`, the marker;
- `declared`: `declared:<file>` or `default`;
- `exit`;
- `errors` and `lints`, the board's counts from its answer, or `null` when nothing was filed (`warnings` is the
  envelope's own list and cannot carry a count);
- the filed `event`;
- or `skipped: not-declared`.

A filed lint run's `tier` reads as any compile ingest's does (`ingested_tier`).

**Cases:**

- **The board is unreachable, or refuses the post** (400, 413): the client's existing ingest-failed warning applies,
  and the verdict still follows the exit code (fold F7).
- **The clients' `runs` and `run` verbs** (`_run_brief`): for a record carrying `lint`, the brief keeps
  `kind: "compile"` and adds `lint: "<tool>"`, and the wording reads `lint` and the tool, never `compile` (fold
  F14).
- **The rust client** (fold F12):
  - `lint` uses the default or the declared command.
  - `clippy` and `workspace-clippy` keep their own arguments. Their posts carry `lint: "clippy"`,
    `format: "clippy"` and `runnerExit`.
  - `check` and the test-compile fallback, which share `_ingest_rustc_stderr`, carry no marker.
  - `clippy`'s exit follows clippy's exit, not the ingest's. Today a failing clippy whose ingest succeeds exits 0.

### §S3 — the gate (folds F3, F4)

Each client's `pre-merge-gate` gains a `lint` stage. Its place in each client's own order:

| Client | Order |
|---|---|
| python, bun | `check` → **lint** → tests |
| arduino | `compile` → **lint** → tests |
| rust | **lint** (its former clippy step) → regression → coverage |
| go | **lint** → `gate_regression` |
| maven | **lint** → docker-up → … (a lint failure starts no container) |

- **Failing:** the gate stops there and answers the failure, with the lint event.
- **Skipped:** the gate continues, and the envelope's warnings carry `lint-not-declared`.
- **Every gate gains `--skip-lint`.** `--skip-check` skips `check` only, never lint.
- **The rust gate's machine contract changes.** Model B's stack files read it, so the mapping is stated here and in
  the CHANGELOG:

  | Before | After |
  |---|---|
  | `stage: "clippy"` | `stage: "lint"` |
  | `errors`, `lints` | `errors`, `lints` (unchanged) |
  | warning `clippy-gate-abort` | warning `lint-gate-abort`, the same in every client |
  | `--skip-clippy` | `--skip-lint`; `--skip-clippy` stays as its alias |
  | `CARGO_BUILD_JOBS` env | unchanged |

### §S4 — Crucible's own declaration

- This checkout's own `crucible.toml`, at the repo root, is git-ignored operator state (CR-CRU-131).
  - At this CR's merge the orchestrator adds the table below to it, beside its `[client]` url, which is not
    touched (user ruling 2026-11-13).
  - The ruff rule set itself is the tracked `pyproject.toml`'s (CR-CRU-253).

  ```toml
  [lint]
  command = ["ruff", "check", "--output-format", "concise", "clients", "crucible_axi", "tests"]
  format = "ruff"
  ```

- Crucible's own gate therefore lints its python. The table is local, so the RUNBOOK's Lint section tells a new
  checkout to add the same table.
- The shipped `clients/crucible.toml` documents `[lint]` in a commented block and declares nothing.

### §S5 — the words

Each of these says what §S1–§S4 say:

- **every client's `--help`:** the `lint` verb, `--skip-lint`, and the gate's stage order;
- **PRD §4.5.1** (fold F13):
  - the table and its fields;
  - the defaults;
  - the not-declared skip and its warning;
  - each client's stage order;
  - the install fallback.

  This replaces its sentence "each project declares its linter in its client config".
- **the RUNBOOK:** a "Lint" section covering:
  - the table;
  - the defaults;
  - the gate;
  - the install-fallback warning;
  - the checkout's own table.
- **the CHANGELOG:** with the rust gate's contract mapping.

Then Model B is told over Sandesh, answering #1488. The message names the rust mapping.

## Acceptance criteria

- [ ] **AC1 — a declared linter runs and files.**
  - **Setup:** a scratch python project declaring `[lint]` ruff, run against a board double.
  - **It runs:** `python-crucible.py lint --agent A` runs the declared command in the project directory.
  - **It posts** `format: "ruff"`, `lint: "ruff"`, `runnerExit` and the output (stdout and stderr in order) to
    `/api/v2/runs/compile`.
  - **A clean run** whose linter printed nothing is posted too, with `runnerExit: 0`.
  - **It answers** with:
    - the verdict;
    - `linter: "ruff"`;
    - `declared: declared:<file>`;
    - `errors` and `lints` from the board's answer;
    - the `event`.
- [ ] **AC2 — the linter's exit code is the verdict.**
  - A linter exiting 1 makes `lint` answer `ok: false`, and the client exits non-zero.
  - A linter exiting 0 answers `ok: true`, even if its output holds warnings.
  - If the board refuses the post or cannot be reached, the verdict still follows the exit, and the ingest-failed
    warning is present.
- [ ] **AC3 — nothing declared is skipped, not refused.**
  - A python project with no `[lint]` answers `ok: true`, `skipped: not-declared`, and posts nothing.
  - Without `--agent`, a declared linter runs, and nothing is posted.
- [ ] **AC4 — the declaration's resolution and refusals.**
  - Any of these is refused before anything runs, and the refusal names the file:
    - `command = "ruff check"` (a string);
    - `command = []`;
    - an empty entry;
    - a non-string `format` or `name`.
  - A `[lint]` declared only in the install's file answers `declared: declared:<install file>`.
- [ ] **AC5 — the command is found, or refused.**
  - A first word not on PATH is refused, naming it, and nothing is posted.
  - A first word holding `/` (`.venv/bin/ruff`) is resolved against the run directory, and runs.
  - In a bun project with `[bun] package_dir`, the command runs in the package directory.
- [ ] **AC6 — the defaults and the marker.**
  - **Rust:** with no `[lint]`, a rust project runs the workspace clippy command with `CARGO_BUILD_JOBS` set, and
    files `format: "clippy"`, `lint: "clippy"`.
  - **Go:** a go project with two modules runs `go vet ./...` in each, and files one post with
    `format: "go vet"`, `lint: "go vet"`. The exit is the first non-zero one.
  - In each, a declared `command` replaces the default.
  - `["python", "-m", "ruff", …]` with `format = "ruff"` posts `lint: "ruff"`.
  - A declared `name` wins.
- [ ] **AC7 — every client has the verb, and the censuses hold** (fold F10).
  - Each of the six clients' `lint` resolves through the shared module.
  - **`test_every_verb_that_runs_a_test_runner_is_classified`:**
    - it classifies `lint`;
    - it recognises the shared lint post as an ingest callee, as it does for `SHARED_INGEST`;
    - its `ROUTE_TABLE` follows rust's moved filings.
  - **`test_every_cycle_help_line_describes_its_own_verb`:** its fixtures declare a `[lint]` with a fake linter, so
    every client's `lint` reaches the board with its cycle.
  - **`test_client_fleet_envelope_census` and its importers:**
    - its fake `go` answers `vet`;
    - its census projects declare `[lint]`.
- [ ] **AC8 — rust's clippy verbs carry the marker, and clippy's exit is its own.**
  - `clippy` and `workspace-clippy` keep their arguments and commands.
  - Their posts carry `lint: "clippy"`, `format: "clippy"` and `runnerExit`.
  - `check`'s post carries no marker.
  - A failing `clippy` exits non-zero even when its ingest succeeds.
- [ ] **AC9 — each gate runs lint in its order.** In each client's `pre-merge-gate`:
  - a failing lint stops the gate at the place §S3's table gives, before any test tier and, for maven, before
    docker-up, naming the lint stage;
  - a skipped lint continues, with a `lint-not-declared` warning in the gate's envelope;
  - `--skip-lint` skips it;
  - `--skip-check` does not.
- [ ] **AC10 — check never lints.** Each client's `check` runs no declared linter, whatever `[lint]` declares.
- [ ] **AC11 — the module ships.**
  - A sandboxed install lays `_crucible_lint.py` down with the fleet.
  - An installed client's `lint` loads it.
  - Every list in §S1 names it.
- [ ] **AC12 — Crucible's own declaration.**
  - Ruff passes on `clients`, `crucible_axi` and `tests` with the project's rule set.
  - The RUNBOOK names the table a checkout adds.
  - After the merge, the orchestrator adds the table to the local root file without touching `[client]`. A
    `bun-crucible.py lint` there answers `declared: declared:<root file>` and `ok: true`. This is recorded at
    close-out, since a test cannot read an untracked file.
- [ ] **AC13 — the words.** Each of these says what §S1–§S4 say:
  - every client's help;
  - the shipped toml's commented `[lint]` block;
  - PRD §4.5.1;
  - the RUNBOOK's Lint section;
  - the CHANGELOG, with the rust mapping.
- [ ] **AC14 — budgets and boundaries.**
  - The core stays at or under 9120 lines (its 80-line headroom under the 9200 guard).
  - `SHARED_MODULE_LINE_BUDGETS` pins `_crucible_lint.py` and the core's new count in all three copies.
  - No `src/` or `public/` file changes.
- [ ] **AC15 — the clients' `runs` and `run` say lint.**
  - For a lint record, the brief keeps `kind: "compile"` and carries `lint`.
  - `runs` and `run` word it as `lint` and its tool.
  - A compile record's brief and wording are unchanged.
- [ ] **AC16 — the rust gate's contract mapping** (fold F4). The rust gate's envelope reads:
  - `stage: "lint"`;
  - `errors` and `lints`;
  - the warning `lint-gate-abort` on an aborted lint step.

  `--skip-clippy` still skips the step.

## Non-goals

- The board side: the marker, the decoders and the view. These are CR-CRU-199.
- ESLint and Biome decoders. Their output is `raw` (user ruling 2026-11-13).
- Running two linters at once, or a list of commands.
- Auto-fixing (`ruff --fix`, `clippy --fix`).
- A timeout on the linter. No client runner has one today.
